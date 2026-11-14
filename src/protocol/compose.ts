/**
 * Protocol Composition from Endpoints
 *
 * Create protocol steps by composing existing endpoint definitions,
 * eliminating schema duplication between endpoints and protocols.
 *
 * @example
 * ```typescript
 * import { handler as loginHandler } from "./routes/api/auth/login.ts";
 *
 * const authProtocol = protocol({
 *   name: "Auth",
 *   initial: "login",
 *   steps: {
 *     login: fromEndpoint(loginHandler, "POST", { name: "login" }),
 *   },
 * });
 * ```
 *
 * @module
 */

import { z } from "zod";
import type { HttpMethod } from "../core/types.ts";
import type { MappingForRequest } from "./dsl.ts";
import type { FieldMapping } from "./mapping.ts";
import type {
  DependentStep,
  MappedStep,
  RequestLocation,
  RequestLocations,
  Step,
} from "./types.ts";

// =============================================================================
// Types
// =============================================================================

/** Handler object with __apiDef metadata (from createApiHandlers) */
export interface HandlerWithApiDef {
  // deno-lint-ignore no-explicit-any
  readonly __apiDef: Record<string, any>;
}

// =============================================================================
// Types derived from an endpoint definition
// =============================================================================

/** HTTP methods a handler object defines. */
export type MethodsOf<H extends HandlerWithApiDef> =
  & keyof H["__apiDef"]
  & HttpMethod;

/** The schema type at `D[K]`, or `never` when the definition has none. */
type SchemaAt<D, K extends string> = K extends keyof D
  ? Extract<D[K], z.ZodType>
  : never;

/** `B` wins over `A` for keys both have, as `Object.assign` does. */
type Override<A, B> = Omit<A, keyof B> & B;

type Simplify<T> = { [K in keyof T]: T[K] } & unknown;

/** Input or output type of one request part; `{}` when it is not defined. */
type PartType<D, K extends string, TSide extends "input" | "output"> =
  [SchemaAt<D, K>] extends [never] ? Record<never, never>
    : TSide extends "input" ? z.input<SchemaAt<D, K>>
    : z.output<SchemaAt<D, K>>;

/**
 * The flat request of a step made from an endpoint: body, query and params
 * merged, later ones winning, as `mergeRequestSchemas` does at runtime.
 *
 * When a part's type is not known statically (a handler typed as the wide
 * `ApiDef`), the result is `unknown`.
 */
type MergedRequest<D, TSide extends "input" | "output"> = unknown extends
  PartType<D, "body", TSide> ? unknown
  : unknown extends PartType<D, "query", TSide> ? unknown
  : unknown extends PartType<D, "params", TSide> ? unknown
  : Simplify<
    Override<
      Override<PartType<D, "body", TSide>, PartType<D, "query", TSide>>,
      PartType<D, "params", TSide>
    >
  >;

/** Request schema type of a step created from the method definition `D`. */
export type EndpointRequestSchema<D> = z.ZodType<
  MergedRequest<D, "output">,
  MergedRequest<D, "input">
>;

/** Response schema type of a step created from the method definition `D`. */
export type EndpointResponseSchema<D> = [SchemaAt<D, "response">] extends
  [never] ? z.ZodUnknown : SchemaAt<D, "response">;

/** Options for fromEndpoint */
export interface FromEndpointOptions<TName extends string = string> {
  /** Step name */
  readonly name: TName;
  /** Override operationId (defaults to endpoint's operationId or name) */
  readonly operationId?: string;
  /** Step description */
  readonly description?: string;
}

/** Options for fromEndpointDependent */
export interface FromEndpointDependentOptions<
  TName extends string = string,
  TDependsOn extends string = string,
  // deno-lint-ignore no-explicit-any
  TPrevResponse = any,
  TRequest extends z.ZodType = z.ZodType,
> {
  /** Step name */
  readonly name: TName;
  /** Override operationId (defaults to endpoint's operationId or name) */
  readonly operationId?: string;
  /** Step description */
  readonly description?: string;
  /** Name of the step this depends on */
  readonly dependsOn: TDependsOn;
  /** Request schema derived from previous step's response */
  readonly request: (prev: TPrevResponse) => TRequest;
}

/** Options for fromEndpointMapped */
export interface FromEndpointMappedOptions<
  TName extends string = string,
  TDependsOn extends string = string,
  TMapping extends Record<string, FieldMapping> = Record<string, FieldMapping>,
> {
  /** Step name */
  readonly name: TName;
  /** Override operationId (defaults to endpoint's operationId or name) */
  readonly operationId?: string;
  /** Step description */
  readonly description?: string;
  /** Name of the step this depends on */
  readonly dependsOn: TDependsOn;
  /** Declarative field-to-step mappings */
  readonly requestMapping: TMapping;
}

// =============================================================================
// Schema Merging
// =============================================================================

/** Generic method definition shape */
interface MethodDefLike {
  readonly body?: z.ZodType;
  readonly query?: z.ZodType;
  readonly params?: z.ZodType;
  readonly response?: z.ZodType;
  readonly operationId?: string;
  readonly description?: string;
}

/** The endpoint schemas that make up a step request, with where each goes. */
const REQUEST_PARTS = [
  ["body", "body"],
  ["query", "query"],
  ["params", "path"],
] as const;

/**
 * Merge body, query, and params schemas into a single request schema, and
 * record which of them each field came from.
 *
 * A field declared in several of the schemas appears once in the request and
 * is sent to each place; its schema is the last one in body, query, params
 * order.
 */
function mergeRequestSchemas(
  def: MethodDefLike,
  method: HttpMethod,
): { schema: z.ZodType; locations: RequestLocations } {
  // deno-lint-ignore no-explicit-any
  const shape: Record<string, any> = {};
  const locations: Record<string, RequestLocation[]> = {};

  for (const [part, location] of REQUEST_PARTS) {
    const schema = def[part];
    if (!schema) continue;

    // deno-lint-ignore no-explicit-any
    const schemaDef = (schema as any)._zod?.def;
    if (schemaDef?.type !== "object" || !schemaDef.shape) {
      throw new Error(
        `Cannot create a step from ${method}: its ${part} schema is not a plain object schema, so its fields cannot be merged into the step request`,
      );
    }

    for (const [key, field] of Object.entries(schemaDef.shape)) {
      shape[key] = field;
      (locations[key] ??= []).push(location);
    }
  }

  return { schema: z.object(shape), locations };
}

// =============================================================================
// Composition Functions
// =============================================================================

/**
 * Create a protocol step from a Fresh endpoint definition.
 *
 * Extracts schemas from the endpoint's __apiDef metadata:
 * - Merges body + query + params into single request schema
 * - Copies response schema directly
 * - Inherits operationId from endpoint (or derives from name)
 *
 * @example
 * ```typescript
 * const handler = createApiHandlers({
 *   POST: endpoint({
 *     body: z.object({ username: z.string(), password: z.string() }),
 *     response: z.object({ accessToken: z.string() }),
 *     handler: async (ctx, { body }) => { ... },
 *   }),
 * });
 *
 * // Create protocol step from endpoint
 * const loginStep = fromEndpoint(handler, "POST", { name: "login" });
 * ```
 */
export function fromEndpoint<
  TName extends string,
  H extends HandlerWithApiDef,
  M extends MethodsOf<H>,
>(
  handler: H,
  method: M,
  options: FromEndpointOptions<TName>,
): Step<
  TName,
  EndpointRequestSchema<H["__apiDef"][M]>,
  EndpointResponseSchema<H["__apiDef"][M]>
> {
  const def = handler.__apiDef[method] as MethodDefLike | undefined;
  if (!def) {
    throw new Error(`No ${method} definition found in handler`);
  }

  const request = mergeRequestSchemas(def, method);
  return {
    __kind: "step",
    name: options.name,
    request: request.schema as EndpointRequestSchema<H["__apiDef"][M]>,
    requestLocations: request.locations,
    response: (def.response ?? z.unknown()) as EndpointResponseSchema<
      H["__apiDef"][M]
    >,
    operationId: options.operationId ?? def.operationId ?? options.name,
    description: options.description ?? def.description,
  };
}

/**
 * Create a dependent protocol step from a Fresh endpoint definition.
 *
 * Like fromEndpoint, but creates a DependentStep where the request schema
 * is derived from the previous step's response.
 *
 * @example
 * ```typescript
 * const refreshStep = fromEndpointDependent<{ refreshToken: string }>(
 *   refreshHandler,
 *   "POST",
 *   {
 *     name: "refresh",
 *     dependsOn: "login",
 *     request: (prev) => z.object({
 *       refreshToken: z.literal(prev.refreshToken),
 *     }),
 *   },
 * );
 * ```
 */
export function fromEndpointDependent<
  TName extends string,
  TDependsOn extends string,
  H extends HandlerWithApiDef,
  M extends MethodsOf<H>,
  // deno-lint-ignore no-explicit-any
  TPrevResponse = any,
  TRequest extends z.ZodType = z.ZodType,
>(
  handler: H,
  method: M,
  options: FromEndpointDependentOptions<
    TName,
    TDependsOn,
    TPrevResponse,
    TRequest
  >,
): DependentStep<
  TName,
  TPrevResponse,
  TRequest,
  EndpointResponseSchema<H["__apiDef"][M]>,
  TDependsOn
> {
  const def = handler.__apiDef[method] as MethodDefLike | undefined;
  if (!def) {
    throw new Error(`No ${method} definition found in handler`);
  }

  return {
    __kind: "dependent_step",
    name: options.name,
    dependsOn: options.dependsOn,
    request: options.request,
    requestLocations: mergeRequestSchemas(def, method).locations,
    response: (def.response ?? z.unknown()) as EndpointResponseSchema<
      H["__apiDef"][M]
    >,
    operationId: options.operationId ?? def.operationId ?? options.name,
    description: options.description ?? def.description,
  };
}

/**
 * Create a mapped protocol step from a Fresh endpoint definition.
 *
 * Like fromEndpoint, but creates a MappedStep with declarative field mappings.
 * The request schema is extracted from the endpoint's body/query/params and
 * the mapping specifies which fields come from previous steps.
 *
 * @example
 * ```typescript
 * const profileStep = fromEndpointMapped(profileHandler, "GET", {
 *   name: "getProfile",
 *   dependsOn: "login",
 *   requestMapping: {
 *     token: fromStep("login", "accessToken"),
 *   },
 * });
 * ```
 */
export function fromEndpointMapped<
  TName extends string,
  TDependsOn extends string,
  const TMapping extends Record<string, FieldMapping>,
  H extends HandlerWithApiDef,
  M extends MethodsOf<H>,
>(
  handler: H,
  method: M,
  options: FromEndpointMappedOptions<TName, TDependsOn, TMapping> & {
    requestMapping: NoInfer<
      MappingForRequest<TMapping, EndpointRequestSchema<H["__apiDef"][M]>>
    >;
  },
): MappedStep<
  TName,
  EndpointRequestSchema<H["__apiDef"][M]>,
  EndpointResponseSchema<H["__apiDef"][M]>,
  TDependsOn,
  TMapping
> {
  const def = handler.__apiDef[method] as MethodDefLike | undefined;
  if (!def) {
    throw new Error(`No ${method} definition found in handler`);
  }

  const request = mergeRequestSchemas(def, method);
  return {
    __kind: "mapped_step",
    name: options.name,
    dependsOn: options.dependsOn,
    requestMapping: options.requestMapping,
    requestSchema: request.schema as EndpointRequestSchema<H["__apiDef"][M]>,
    requestLocations: request.locations,
    response: (def.response ?? z.unknown()) as EndpointResponseSchema<
      H["__apiDef"][M]
    >,
    operationId: options.operationId ?? def.operationId ?? options.name,
    description: options.description ?? def.description,
  };
}

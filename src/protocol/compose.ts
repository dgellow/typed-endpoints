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
import type { ApiDef, HttpMethod } from "../core/types.ts";
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
  __apiDef: ApiDef;
}

/** Options for fromEndpoint */
export interface FromEndpointOptions<TName extends string = string> {
  /** Step name */
  name: TName;
  /** Override operationId (defaults to endpoint's operationId or name) */
  operationId?: string;
  /** Step description */
  description?: string;
}

/** Options for fromEndpointDependent */
export interface FromEndpointDependentOptions<
  TName extends string = string,
  TDependsOn extends string = string,
> {
  /** Step name */
  name: TName;
  /** Override operationId (defaults to endpoint's operationId or name) */
  operationId?: string;
  /** Step description */
  description?: string;
  /** Name of the step this depends on */
  dependsOn: TDependsOn;
  /** Request schema derived from previous step's response */
  // deno-lint-ignore no-explicit-any
  request: (prev: any) => z.ZodType;
}

/** Options for fromEndpointMapped */
export interface FromEndpointMappedOptions<
  TName extends string = string,
  TDependsOn extends string = string,
  TMapping extends Record<string, FieldMapping> = Record<string, FieldMapping>,
> {
  /** Step name */
  name: TName;
  /** Override operationId (defaults to endpoint's operationId or name) */
  operationId?: string;
  /** Step description */
  description?: string;
  /** Name of the step this depends on */
  dependsOn: TDependsOn;
  /** Declarative field-to-step mappings */
  requestMapping: TMapping;
}

// =============================================================================
// Schema Merging
// =============================================================================

/** Generic method definition shape */
interface MethodDefLike {
  body?: z.ZodType;
  query?: z.ZodType;
  params?: z.ZodType;
  response?: z.ZodType;
  operationId?: string;
  description?: string;
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
export function fromEndpoint<TName extends string>(
  handler: HandlerWithApiDef,
  method: HttpMethod,
  options: FromEndpointOptions<TName>,
): Step<TName, z.ZodType, z.ZodType> {
  const def = handler.__apiDef[method] as MethodDefLike | undefined;
  if (!def) {
    throw new Error(`No ${method} definition found in handler`);
  }

  const request = mergeRequestSchemas(def, method);
  return {
    __kind: "step",
    name: options.name,
    request: request.schema,
    requestLocations: request.locations,
    response: def.response ?? z.unknown(),
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
>(
  handler: HandlerWithApiDef,
  method: HttpMethod,
  options: FromEndpointDependentOptions<TName, TDependsOn>,
  // deno-lint-ignore no-explicit-any
): DependentStep<TName, any, z.ZodType, z.ZodType, TDependsOn> {
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
    response: def.response ?? z.unknown(),
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
>(
  handler: HandlerWithApiDef,
  method: HttpMethod,
  options: FromEndpointMappedOptions<TName, TDependsOn, TMapping>,
): MappedStep<TName, z.ZodType, z.ZodType, TDependsOn, TMapping> {
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
    requestSchema: request.schema,
    requestLocations: request.locations,
    response: def.response ?? z.unknown(),
    operationId: options.operationId ?? def.operationId ?? options.name,
    description: options.description ?? def.description,
  };
}

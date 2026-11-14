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
import { apiPathToTemplate, deriveOperationId } from "../core/routes.ts";
import type { HttpMethod } from "../core/types.ts";
import { zodDef } from "../core/zod_internals.ts";
import type { MappingForRequest } from "./dsl.ts";
import type { FieldMapping } from "./mapping.ts";
import type {
  DependentStep,
  MappedStep,
  RequestLocation,
  RequestLocations,
  Step,
  StepOutcome,
  StepRoute,
} from "./types.ts";

// =============================================================================
// Types
// =============================================================================

/** Handler object with __apiDef metadata (from createApiHandlers) */
export interface HandlerWithApiDef {
  /** Method definitions attached by `createApiHandlers()`. */
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
export type SchemaAt<D, K extends string> = K extends keyof D
  ? Extract<D[K], z.ZodType>
  : never;

/** `B` wins over `A` for keys both have, as `Object.assign` does. */
export type Override<A, B> = Omit<A, keyof B> & B;

/** Flattens an intersection into one object type, for readable hovers. */
export type Simplify<T> = { [K in keyof T]: T[K] } & unknown;

/** Input or output type of one request part; `{}` when it is not defined. */
export type PartType<
  D,
  K extends string,
  TSide extends "input" | "output",
> = [SchemaAt<D, K>] extends [never] ? Record<never, never>
  : TSide extends "input" ? z.input<SchemaAt<D, K>>
  : z.output<SchemaAt<D, K>>;

/**
 * The flat request of a step made from an endpoint: body, query and params
 * merged, later ones winning, as `mergeRequestSchemas` does at runtime.
 *
 * When a part's type is not known statically (a handler typed as the wide
 * `ApiDef`), the result is `unknown`.
 */
export type MergedRequest<D, TSide extends "input" | "output"> = unknown extends
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

/**
 * Status codes of the error responses a method definition declares: the
 * keys of its `responses` from 400 upwards.
 */
export type ErrorStatusOf<D> = D extends { readonly responses?: infer R }
  ? NonNullable<R> extends infer TDeclared ? {
      [S in keyof TDeclared & number]: `${S}` extends
        `4${string}` | `5${string}` ? S : never;
    }[keyof TDeclared & number]
  : never
  : never;

/** The schema a method definition declares for status `S`. */
export type DeclaredSchema<D, S> = D extends { readonly responses?: infer R }
  ? S extends keyof NonNullable<R>
    ? NonNullable<R>[S] extends z.ZodType ? NonNullable<R>[S]
    : NonNullable<R>[S] extends { readonly schema: infer T extends z.ZodType }
      ? T
    : never
  : never
  : never;

/**
 * What a call to an endpoint ended with, as a value: the response, or one
 * of the error responses the endpoint declares, told apart by `ok` and
 * `status`.
 */
export type EndpointOutcome<D> =
  | {
    /** The call succeeded. */
    readonly ok: true;
    /** The HTTP status, 200 to 299. */
    readonly status: number;
    /** The response body. */
    readonly body: z.output<EndpointResponseSchema<D>>;
  }
  | {
    [S in ErrorStatusOf<D>]: {
      /** The server answered with a declared error status. */
      readonly ok: false;
      /** The HTTP status. */
      readonly status: S;
      /** The body declared for that status. */
      readonly body: z.output<DeclaredSchema<D, S>>;
    };
  }[ErrorStatusOf<D>];

/**
 * Response schema type of a step created from the method definition `D`:
 * the endpoint's response, or its outcome when the step asks for one.
 */
export type StepResponseSchema<D, TOutcome extends boolean> = TOutcome extends
  true ? z.ZodType<EndpointOutcome<D>> : EndpointResponseSchema<D>;

/** What steps made from an endpoint have in common in their options. */
export interface OutcomeOption<TOutcome extends boolean = boolean> {
  /**
   * Make the step's response the outcome of the call:
   * `{ ok: true, status, body }` for a success and
   * `{ ok: false, status, body }` for each error status the endpoint
   * declares in `responses`. A step that follows can then say which
   * outcome it follows (`when: (prev) => prev.ok`) and a plan can branch
   * on it, without `try`/`catch`. The HTTP executor returns a declared
   * error status as a response; a status the endpoint does not declare is
   * still an `HttpError`.
   */
  readonly outcome?: TOutcome;
}

/** Options for fromEndpoint */
export interface FromEndpointOptions<TName extends string = string> {
  /** Step name */
  readonly name: TName;
  /**
   * Path the endpoint is served at, e.g. `/api/users/{id}` (the file-route
   * form `/api/users/[id]` is accepted too). The step then knows its route:
   * the HTTP executor needs no route table for it, and no `operationId`
   * has to be written to connect the two.
   */
  readonly path?: string;
  /**
   * Override operationId. Defaults to the endpoint's `operationId`; without
   * one, to the id the route generators derive from `path` and the method
   * (`usersRetrieve`), or to the step name when no `path` is given.
   */
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
  /**
   * Path the endpoint is served at, e.g. `/api/users/{id}` (the file-route
   * form `/api/users/[id]` is accepted too). The step then knows its route:
   * the HTTP executor needs no route table for it, and no `operationId`
   * has to be written to connect the two.
   */
  readonly path?: string;
  /**
   * Override operationId. Defaults to the endpoint's `operationId`; without
   * one, to the id the route generators derive from `path` and the method
   * (`usersRetrieve`), or to the step name when no `path` is given.
   */
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
  /**
   * Path the endpoint is served at, e.g. `/api/users/{id}` (the file-route
   * form `/api/users/[id]` is accepted too). The step then knows its route:
   * the HTTP executor needs no route table for it, and no `operationId`
   * has to be written to connect the two.
   */
  readonly path?: string;
  /**
   * Override operationId. Defaults to the endpoint's `operationId`; without
   * one, to the id the route generators derive from `path` and the method
   * (`usersRetrieve`), or to the step name when no `path` is given.
   */
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
  readonly responses?: Readonly<
    Record<string, z.ZodType | { readonly schema: z.ZodType }>
  >;
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

    const schemaDef = zodDef(schema);
    if (schemaDef.type !== "object" || !schemaDef.shape) {
      throw new Error(
        `Cannot create a step from ${method}: its ${part} schema is not a plain object schema, so its fields cannot be merged into the step request`,
      );
    }

    for (
      const [key, field] of Object.entries(
        schemaDef.shape as Record<string, z.ZodType>,
      )
    ) {
      shape[key] = field;
      (locations[key] ??= []).push(location);
    }
  }

  return { schema: z.object(shape), locations };
}

/**
 * The response schema of a step made from an endpoint: the endpoint's
 * response, or, when the step asks for the outcome, a union of
 * `{ ok: true, status, body }` and one `{ ok: false, status, body }` per
 * declared error status.
 */
function responseOf(
  def: MethodDefLike,
  outcome: boolean | undefined,
): { response: z.ZodType; outcome?: StepOutcome } {
  const response = def.response ?? z.unknown();
  if (!outcome) return { response };

  const errors = Object.entries(def.responses ?? {})
    .map(([status, value]) =>
      [Number(status), "schema" in value ? value.schema : value] as const
    )
    .filter(([status]) => status >= 400)
    .sort(([a], [b]) => a - b);

  const success = z.object({
    ok: z.literal(true),
    status: z.number(),
    body: response,
  });
  const failures = errors.map(([status, schema]) =>
    z.object({ ok: z.literal(false), status: z.literal(status), body: schema })
  );
  return {
    response: failures.length === 0 ? success : z.union([success, ...failures]),
    outcome: { errors: errors.map(([status]) => status) },
  };
}

/**
 * How a step made from an endpoint is found over HTTP: its route, when
 * the path is given, and its operationId.
 *
 * With a path, the operationId is the one the route generators derive for
 * that path and method, so the step also matches a generated route table.
 */
function routing(
  handler: HandlerWithApiDef,
  method: HttpMethod,
  def: MethodDefLike,
  options: {
    readonly name: string;
    readonly path?: string;
    readonly operationId?: string;
  },
  locations: RequestLocations,
): { route?: StepRoute; operationId: string } {
  if (options.path === undefined) {
    return {
      operationId: options.operationId ?? def.operationId ?? options.name,
    };
  }

  const path = apiPathToTemplate(options.path);
  for (const [, param] of path.matchAll(/\{(\w+)\}/g)) {
    if (!locations[param]?.includes("path")) {
      throw new Error(
        `Cannot create step "${options.name}": the path ${path} has the parameter "${param}", which the ${method} endpoint does not declare in its params schema`,
      );
    }
  }

  // The generators name an operation from the file-route form of its path
  // and the methods the path defines.
  const filePath = path.replace(/\{(\w+)\}/g, "[$1]");
  return {
    route: { method, path },
    operationId: options.operationId ?? def.operationId ??
      deriveOperationId(filePath, method, Object.keys(handler.__apiDef)),
  };
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
  const TOutcome extends boolean = false,
>(
  handler: H,
  method: M,
  options: FromEndpointOptions<TName> & OutcomeOption<TOutcome>,
): Step<
  TName,
  EndpointRequestSchema<H["__apiDef"][M]>,
  StepResponseSchema<H["__apiDef"][M], TOutcome>
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
    ...responseOf(def, options.outcome) as {
      response: StepResponseSchema<H["__apiDef"][M], TOutcome>;
    },
    ...routing(handler, method, def, options, request.locations),
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
  const TOutcome extends boolean = false,
>(
  handler: H,
  method: M,
  options:
    & FromEndpointDependentOptions<
      TName,
      TDependsOn,
      TPrevResponse,
      TRequest
    >
    & OutcomeOption<TOutcome>,
): DependentStep<
  TName,
  TPrevResponse,
  TRequest,
  StepResponseSchema<H["__apiDef"][M], TOutcome>,
  TDependsOn
> {
  const def = handler.__apiDef[method] as MethodDefLike | undefined;
  if (!def) {
    throw new Error(`No ${method} definition found in handler`);
  }

  const locations = mergeRequestSchemas(def, method).locations;
  return {
    __kind: "dependent_step",
    name: options.name,
    dependsOn: options.dependsOn,
    request: options.request,
    requestLocations: locations,
    ...responseOf(def, options.outcome) as {
      response: StepResponseSchema<H["__apiDef"][M], TOutcome>;
    },
    ...routing(handler, method, def, options, locations),
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
  const TOutcome extends boolean = false,
>(
  handler: H,
  method: M,
  options:
    & FromEndpointMappedOptions<TName, TDependsOn, TMapping>
    & OutcomeOption<TOutcome>
    & {
      requestMapping: NoInfer<
        MappingForRequest<TMapping, EndpointRequestSchema<H["__apiDef"][M]>>
      >;
    },
): MappedStep<
  TName,
  EndpointRequestSchema<H["__apiDef"][M]>,
  StepResponseSchema<H["__apiDef"][M], TOutcome>,
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
    ...responseOf(def, options.outcome) as {
      response: StepResponseSchema<H["__apiDef"][M], TOutcome>;
    },
    ...routing(handler, method, def, options, request.locations),
    description: options.description ?? def.description,
  };
}

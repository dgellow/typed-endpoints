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
import type { DependentStep, Step } from "./types.ts";

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

/**
 * Merge body, query, and params schemas into a single request schema.
 *
 * Combines all fields from the three schemas into one flat object schema.
 * Handles cases where schemas might be undefined or non-object types.
 */
function mergeRequestSchemas(def: MethodDefLike): z.ZodType {
  // deno-lint-ignore no-explicit-any
  const shapes: Record<string, any> = {};

  for (const schema of [def.body, def.query, def.params]) {
    if (!schema) continue;

    // Access Zod v4 internal _def to get shape
    // deno-lint-ignore no-explicit-any
    const schemaDef = (schema as any)._def;
    if (schemaDef?.type === "object" && schemaDef?.shape) {
      Object.assign(shapes, schemaDef.shape);
    }
  }

  return Object.keys(shapes).length > 0 ? z.object(shapes) : z.object({});
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

  return {
    __kind: "step",
    name: options.name,
    request: mergeRequestSchemas(def),
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
    response: def.response ?? z.unknown(),
    operationId: options.operationId ?? def.operationId ?? options.name,
    description: options.description ?? def.description,
  };
}

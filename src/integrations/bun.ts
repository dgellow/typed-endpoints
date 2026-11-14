/**
 * Bun Integration
 *
 * Runtime adapter for `Bun.serve()`. The same helpers as the Fresh
 * integration, with Bun's request as the handler context:
 *
 * - endpoint() / sseEndpoint() — define typed API methods
 * - createApiHandlers() — wrap methods into a route object with validation
 * - fileRoutes() — build the `routes` option from a directory of route files
 *
 * @example
 * ```ts
 * // routes/api/users/[id].ts
 * import { z } from "zod";
 * import { createApiHandlers, endpoint } from "@dgellow/typed-endpoints/bun";
 *
 * export const handler = createApiHandlers({
 *   GET: endpoint({
 *     params: z.object({ id: z.string() }),
 *     response: z.object({ id: z.string(), name: z.string() }),
 *     handler: (_req, { params }) => Response.json({ id: params.id, name: "Ada" }),
 *   }),
 * });
 *
 * // server.ts
 * import { fileRoutes } from "@dgellow/typed-endpoints/bun";
 *
 * Bun.serve({ routes: await fileRoutes("routes") });
 * ```
 *
 * Route files follow the conventions the generators read (`[param]`,
 * `[...rest]`, `(group)`, `index`), so `generateTypes()` and
 * `generateOpenApiSpec()` work on the same directory.
 *
 * @module
 */

import type { z } from "zod";
import type { SseEventDef } from "../core/types.ts";
import {
  buildHandlers,
  type HandlerMethodDef,
  type Handlers,
  type HandlerSseMethodDef,
} from "../core/handlers.ts";
import { formatApiPath, loadFileRoutes } from "../core/file_routes.ts";

export type { SseEvent, SseEventDef, SseMethodDef } from "../core/types.ts";
export type {
  ApiDefOf,
  HandlerMethodDef,
  HandlerResult,
  Handlers,
  HandlerSseMethodDef,
} from "../core/handlers.ts";

/**
 * The request Bun passes to a route handler: a standard `Request` with the
 * path parameters of the matched route.
 *
 * Declared here so that the package does not depend on Bun's type
 * definitions; Bun's own `BunRequest` is assignable to it.
 */
export type BunRequest = Request & {
  /** Path parameters of the matched route. */
  readonly params?: Readonly<Record<string, string>>;
};

/** Method definition whose handler receives Bun's request. */
export type BunApiMethodDef<
  TBodySchema extends z.ZodType | undefined = undefined,
  TQuerySchema extends z.ZodType | undefined = undefined,
  TParamsSchema extends z.ZodType | undefined = undefined,
  TResponseSchema extends z.ZodType | undefined = z.ZodType | undefined,
> = HandlerMethodDef<
  BunRequest,
  TBodySchema,
  TQuerySchema,
  TParamsSchema,
  TResponseSchema
>;

/**
 * Define an API endpoint with full type inference for the handler.
 *
 * Zero runtime cost: returns its argument. It exists so that the schemas
 * type the `validated` argument of the handler.
 */
export function endpoint<
  TBodySchema extends z.ZodType | undefined = undefined,
  TQuerySchema extends z.ZodType | undefined = undefined,
  TParamsSchema extends z.ZodType | undefined = undefined,
  TResponseSchema extends z.ZodType | undefined = undefined,
>(
  def: BunApiMethodDef<
    TBodySchema,
    TQuerySchema,
    TParamsSchema,
    TResponseSchema
  >,
): BunApiMethodDef<TBodySchema, TQuerySchema, TParamsSchema, TResponseSchema> {
  return def;
}

/** SSE method definition whose generator receives Bun's request. */
export type BunSseMethodDef<
  TQuerySchema extends z.ZodType | undefined = undefined,
  TParamsSchema extends z.ZodType | undefined = undefined,
  TEvents extends SseEventDef = SseEventDef,
> = HandlerSseMethodDef<BunRequest, TQuerySchema, TParamsSchema, TEvents>;

/**
 * Define an SSE endpoint with full type inference.
 *
 * Zero runtime cost: returns its argument.
 */
export function sseEndpoint<
  TQuerySchema extends z.ZodType | undefined = undefined,
  TParamsSchema extends z.ZodType | undefined = undefined,
  TEvents extends SseEventDef = SseEventDef,
>(
  def: BunSseMethodDef<TQuerySchema, TParamsSchema, TEvents>,
): BunSseMethodDef<TQuerySchema, TParamsSchema, TEvents> {
  return def;
}

/** What `createApiHandlers()` returns: one handler per defined method. */
export type BunHandlers<TDef> = Handlers<BunRequest, TDef>;

/**
 * Create a route object for `Bun.serve({ routes })` with automatic
 * validation: `{ GET: (req) => Response, POST: ... }`.
 *
 * The definitions are attached as `__apiDef` for the generators. The
 * property is not enumerable, so the object has only method keys.
 */
export function createApiHandlers<TDef extends Record<string, unknown>>(
  apiDef: TDef,
): BunHandlers<TDef> {
  return buildHandlers<BunRequest, TDef>(apiDef, {
    request: (req) => req,
    params: (req) => ({ ...req.params }),
  }, { hiddenApiDef: true });
}

/** A route object: handlers by HTTP method. */
export type BunRouteHandlers = Readonly<
  Record<string, (req: BunRequest) => Response | Promise<Response>>
>;

/**
 * Bun's route pattern for a file-route path: `/users/[id]` is
 * `/users/:id`, `/files/[...path]` is `/files/*`.
 */
export function toBunRoutePattern(apiPath: string): string {
  return formatApiPath(apiPath, {
    param: (name) => `:${name}`,
    rest: () => "*",
  });
}

/**
 * Build the `routes` option of `Bun.serve()` from a directory of route
 * files.
 *
 * Each file that exports `handler` becomes one route. The URL path comes
 * from the file path below the `routes` directory, as for the generators:
 * `routes/api/users/[id].ts` serves `/api/users/:id`.
 *
 * A catch-all `[...rest]` becomes Bun's `*`, which has no parameter name:
 * the handler reads the rest of the path from the request URL.
 *
 * @param dir Directory that holds the route files.
 */
export async function fileRoutes(
  dir: string,
): Promise<Record<string, BunRouteHandlers>> {
  const routes: Record<string, BunRouteHandlers> = {};
  for (const route of await loadFileRoutes<BunRouteHandlers>(dir)) {
    routes[toBunRoutePattern(route.apiPath)] = route.handlers;
  }
  return routes;
}

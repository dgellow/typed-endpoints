/**
 * Hono Integration
 *
 * - endpoint() / sseEndpoint() — define typed API methods
 * - createApiHandlers() — Hono handlers `(c) => Response`, one per method
 * - mountFileRoutes() — register a directory of route files on an app
 * - withContext() — the same helpers typed with your app's `Context`
 *
 * @example
 * ```ts
 * import { Hono } from "hono";
 * import { z } from "zod";
 * import { createApiHandlers, endpoint } from "@dgellow/typed-endpoints/hono";
 *
 * const users = createApiHandlers({
 *   GET: endpoint({
 *     params: z.object({ id: z.string() }),
 *     handler: (c, { params }) => c.json({ id: params.id }),
 *   }),
 * });
 *
 * const app = new Hono();
 * app.get("/api/users/:id", users.GET);
 * ```
 *
 * The package does not depend on Hono: the context is described by the
 * two members this module reads, which Hono's `Context` has.
 *
 * @module
 */

import { defineIntegration, type Integration } from "../core/handlers.ts";
import { formatApiPath, loadFileRoutes } from "../core/file_routes.ts";

export type { SseEvent, SseEventDef, SseMethodDef } from "../core/types.ts";
export type {
  ApiDefOf,
  HandlerMethodDef,
  HandlerResult,
  Handlers,
  HandlerSseMethodDef,
  Integration,
} from "../core/handlers.ts";

/** What this module reads from Hono's `Context`. */
export interface HonoContext {
  /** Hono's request wrapper. */
  readonly req: {
    /** The standard request. */
    readonly raw: Request;
    /** The path parameters of the matched route. */
    param(): Record<string, string>;
  };
}

/**
 * The helpers typed with your app's context, so that a handler sees its
 * variables and bindings: `withContext<Context<Env>>()`.
 */
export function withContext<
  TContext extends HonoContext = HonoContext,
>(): Integration<TContext> {
  return defineIntegration<TContext>({
    request: (c) => c.req.raw,
    params: (c) => c.req.param(),
  }, { hiddenApiDef: true });
}

/** The helpers of the Hono integration, for the minimal context. */
export type HonoIntegration = Integration<HonoContext>;

const integration: HonoIntegration = withContext();

/** Define an API endpoint; the handler receives Hono's context. */
export const endpoint: HonoIntegration["endpoint"] = integration.endpoint;

/** Define an SSE endpoint; the generator receives Hono's context. */
export const sseEndpoint: HonoIntegration["sseEndpoint"] =
  integration.sseEndpoint;

/** Create Hono handlers with automatic validation, one per method. */
export const createApiHandlers: HonoIntegration["createApiHandlers"] =
  integration.createApiHandlers;

/**
 * Hono's path for a file-route path: `/users/[id]` is `/users/:id`, and a
 * catch-all `/files/[...path]` is `/files/:path{.+}`, a named parameter
 * that spans segments.
 */
export function toHonoPath(apiPath: string): string {
  return formatApiPath(apiPath, {
    param: (name) => `:${name}`,
    rest: (name) => `:${name}{.+}`,
  });
}

/** What `mountFileRoutes()` needs from a Hono app. */
export interface HonoRouter {
  /** Register handlers for a method and a path. */
  // deno-lint-ignore no-explicit-any
  on(method: string, path: string, ...handlers: any[]): unknown;
}

/**
 * Register every route file below `dir` on a Hono app.
 *
 * Each file that exports `handler` is one route; its path comes from the
 * file path below the `routes` directory: `routes/api/users/[id].ts` is
 * registered as `/api/users/:id`. Returns the registered paths.
 */
export async function mountFileRoutes(
  app: HonoRouter,
  dir: string,
): Promise<string[]> {
  const paths: string[] = [];
  const routes = await loadFileRoutes<
    Record<string, (c: HonoContext) => Response | Promise<Response>>
  >(dir);
  for (const route of routes) {
    const path = toHonoPath(route.apiPath);
    for (const [method, handler] of Object.entries(route.handlers)) {
      app.on(method, path, handler);
    }
    paths.push(path);
  }
  return paths;
}

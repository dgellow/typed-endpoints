/**
 * Plain fetch handlers
 *
 * For anything that serves `(request: Request) => Response`: `Deno.serve`,
 * Cloudflare Workers, `Bun.serve({ fetch })`, a test. No framework: this
 * module brings a small router.
 *
 * - endpoint() / sseEndpoint() — define typed API methods
 * - createApiHandlers() — handlers `(request, params) => Response`
 * - createRouter() — one fetch handler from a table of routes
 * - fileRouter() — the same from a directory of route files
 *
 * @example
 * ```ts
 * // routes/api/users/[id].ts
 * import { z } from "zod";
 * import { createApiHandlers, endpoint } from "@dgellow/typed-endpoints/fetch";
 *
 * export const handler = createApiHandlers({
 *   GET: endpoint({
 *     params: z.object({ id: z.string() }),
 *     handler: (_request, { params }) => Response.json({ id: params.id }),
 *   }),
 * });
 *
 * // main.ts
 * import { fileRouter } from "@dgellow/typed-endpoints/fetch";
 *
 * Deno.serve(await fileRouter("routes"));
 * ```
 *
 * @module
 */

import { defineIntegration, type Integration } from "../core/handlers.ts";
import {
  loadFileRoutes,
  parseApiPath,
  type PathSegment,
} from "../core/file_routes.ts";

export type { SseEvent, SseEventDef, SseMethodDef } from "../core/types.ts";
export type {
  ApiDefOf,
  HandlerMethodDef,
  HandlerResult,
  Handlers,
  HandlerSseMethodDef,
  Integration,
} from "../core/handlers.ts";

/** Path parameters of a matched route. */
export type RouteParams = Readonly<Record<string, string>>;

/** The helpers of the fetch integration. */
export type FetchIntegration = Integration<Request, [params?: RouteParams]>;

const integration: FetchIntegration = defineIntegration<
  Request,
  [params?: RouteParams]
>({
  request: (request) => request,
  params: (_request, params) => params,
}, { hiddenApiDef: true });

/** Define an API endpoint; the handler receives the `Request`. */
export const endpoint: FetchIntegration["endpoint"] = integration.endpoint;

/** Define an SSE endpoint; the generator receives the `Request`. */
export const sseEndpoint: FetchIntegration["sseEndpoint"] =
  integration.sseEndpoint;

/**
 * Create handlers `(request, params) => Promise<Response>` with automatic
 * validation, one per method.
 */
export const createApiHandlers: FetchIntegration["createApiHandlers"] =
  integration.createApiHandlers;

/** The handlers of one route, by HTTP method. */
export type RouteHandlers = Readonly<
  Record<
    string,
    (request: Request, params?: RouteParams) => Response | Promise<Response>
  >
>;

/** Options of `createRouter()`. */
export interface RouterOptions {
  /** Answers a request no route matches. Default: 404 with a JSON body. */
  readonly notFound?: (request: Request) => Response | Promise<Response>;
}

function jsonError(error: string, status: number, headers?: HeadersInit) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

interface CompiledRoute {
  readonly segments: readonly PathSegment[];
  readonly handlers: RouteHandlers;
}

/** `:id` and a trailing `*` are accepted next to `[id]` and `[...rest]`. */
function toApiPath(pattern: string): string {
  return pattern
    .replace(/\/\*$/, "/[...rest]")
    .replace(/:(\w+)/g, "[$1]");
}

/** Static segments before parameters before a catch-all, segment by segment. */
function specificity(a: CompiledRoute, b: CompiledRoute): number {
  const rank = { static: 0, param: 1, rest: 2 };
  const length = Math.max(a.segments.length, b.segments.length);
  for (let i = 0; i < length; i++) {
    const left = a.segments[i], right = b.segments[i];
    if (!left) return -1;
    if (!right) return 1;
    if (rank[left.kind] !== rank[right.kind]) {
      return rank[left.kind] - rank[right.kind];
    }
  }
  return 0;
}

function match(
  segments: readonly PathSegment[],
  parts: readonly string[],
): Record<string, string> | undefined {
  const params: Record<string, string> = {};
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment.kind === "rest") {
      params[segment.name] = parts.slice(i).join("/");
      return params;
    }
    const part = parts[i];
    if (part === undefined) return undefined;
    if (segment.kind === "static") {
      if (segment.value !== part) return undefined;
    } else {
      params[segment.name] = part;
    }
  }
  return parts.length === segments.length ? params : undefined;
}

/**
 * Create one fetch handler from a table of routes.
 *
 * A key is a path with parameters, in file-route notation
 * (`/users/[id]`, `/files/[...path]`) or in the common `:id` and trailing
 * `*` spelling. A route with more static segments wins over one with
 * parameters, which wins over a catch-all. Parameter values are
 * URL-decoded.
 *
 * A path no route matches is answered with 404; a method the matched
 * route does not define with 405 and an `Allow` header.
 */
export function createRouter(
  routes: Readonly<Record<string, RouteHandlers>>,
  options: RouterOptions = {},
): (request: Request) => Promise<Response> {
  const compiled: CompiledRoute[] = Object.entries(routes)
    .map(([pattern, handlers]) => ({
      segments: parseApiPath(toApiPath(pattern)),
      handlers,
    }))
    .sort(specificity);

  return async (request) => {
    let parts: string[];
    try {
      parts = new URL(request.url).pathname.split("/").filter((p) => p !== "")
        .map(decodeURIComponent);
    } catch {
      return jsonError("Malformed URL path", 400);
    }

    for (const route of compiled) {
      const params = match(route.segments, parts);
      if (!params) continue;

      const handler = route.handlers[request.method];
      if (!handler) {
        const allow = Object.keys(route.handlers).join(", ");
        return jsonError("Method not allowed", 405, { Allow: allow });
      }
      return await handler(request, params);
    }

    return options.notFound
      ? await options.notFound(request)
      : jsonError("Not found", 404);
  };
}

/**
 * Create one fetch handler from a directory of route files.
 *
 * Each file that exports `handler` is one route; its path comes from the
 * file path below the `routes` directory: `routes/api/users/[id].ts`
 * serves `/api/users/{id}`.
 */
export async function fileRouter(
  dir: string,
  options: RouterOptions = {},
): Promise<(request: Request) => Promise<Response>> {
  const routes: Record<string, RouteHandlers> = {};
  for (const route of await loadFileRoutes<RouteHandlers>(dir)) {
    routes[route.apiPath] = route.handlers;
  }
  return createRouter(routes, options);
}

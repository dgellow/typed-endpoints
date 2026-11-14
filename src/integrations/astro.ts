/**
 * Astro Integration (endpoints)
 *
 * - endpoint() / sseEndpoint() — define typed API methods
 * - createApiHandlers() — API routes `(context) => Response`, to export by
 *   method name
 * - withContext() — the same helpers typed with your `APIContext`
 *
 * @example
 * ```ts
 * // src/pages/api/users/[id].ts
 * import { z } from "zod";
 * import { createApiHandlers, endpoint } from "@dgellow/typed-endpoints/astro";
 *
 * export const prerender = false;
 *
 * export const { GET } = createApiHandlers({
 *   GET: endpoint({
 *     params: z.object({ id: z.string() }),
 *     handler: (_context, { params }) => Response.json({ id: params.id }),
 *   }),
 * });
 * ```
 *
 * An endpoint file exports one function per HTTP method. The definitions
 * for the generators travel on those functions. Generate with the `astro`
 * convention:
 * `generateTypes({ routesDirs: ["src/pages/api"], convention: "astro" })`.
 *
 * @module
 */

import { defineIntegration, type Integration } from "../core/handlers.ts";

export type { SseEvent, SseEventDef, SseMethodDef } from "../core/types.ts";
export type {
  ApiDefOf,
  HandlerMethodDef,
  Handlers,
  HandlerSseMethodDef,
  Integration,
} from "../core/handlers.ts";

/** What this module reads from Astro's `APIContext`. */
export interface AstroContext {
  /** The standard request. */
  readonly request: Request;
  /** The parameters of the matched route. */
  readonly params: Readonly<Record<string, string | undefined>>;
}

/**
 * The helpers typed with your context type, so that a handler sees
 * `locals` and `cookies`: `withContext<APIContext>()`.
 */
export function withContext<
  TContext extends AstroContext = AstroContext,
>(): Integration<TContext> {
  return defineIntegration<TContext>({
    request: (context) => context.request,
    params: (context) => context.params,
  });
}

/** The helpers of the Astro integration, for the minimal context. */
export type AstroIntegration = Integration<AstroContext>;

const integration: AstroIntegration = withContext();

/** Define an API endpoint; the handler receives Astro's context. */
export const endpoint: AstroIntegration["endpoint"] = integration.endpoint;

/** Define an SSE endpoint; the generator receives Astro's context. */
export const sseEndpoint: AstroIntegration["sseEndpoint"] =
  integration.sseEndpoint;

/**
 * Create API routes with automatic validation. Destructure the result
 * into the exports of the endpoint file: `export const { GET } = ...`.
 */
export const createApiHandlers: AstroIntegration["createApiHandlers"] =
  integration.createApiHandlers;

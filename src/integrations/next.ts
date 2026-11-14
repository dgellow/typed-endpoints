/**
 * Next.js Integration (App Router route handlers)
 *
 * - endpoint() / sseEndpoint() — define typed API methods
 * - createApiHandlers() — route handlers `(request, { params })`, to export
 *   by method name
 * - withRequest() — the same helpers typed with `NextRequest`
 *
 * @example
 * ```ts
 * // app/api/users/[id]/route.ts
 * import { z } from "zod";
 * import { createApiHandlers, endpoint } from "@dgellow/typed-endpoints/next";
 *
 * export const { GET, DELETE } = createApiHandlers({
 *   GET: endpoint({
 *     params: z.object({ id: z.string() }),
 *     handler: (_request, { params }) => Response.json({ id: params.id }),
 *   }),
 *   DELETE: endpoint({
 *     params: z.object({ id: z.string() }),
 *     handler: () => new Response(null, { status: 204 }),
 *   }),
 * });
 * ```
 *
 * A `route.ts` may only export the method handlers and Next.js's own
 * options. The definitions for the generators therefore travel on the
 * handler functions. Generate with the `next` convention:
 * `generateTypes({ routesDirs: ["app/api"], convention: "next" })`.
 *
 * `params` is awaited: Next.js passes it as a promise.
 *
 * @module
 */

import {
  defineIntegration,
  type Integration,
  type RawParams,
} from "../core/handlers.ts";

export type { SseEvent, SseEventDef, SseMethodDef } from "../core/types.ts";
export type {
  ApiDefOf,
  HandlerMethodDef,
  HandlerResult,
  Handlers,
  HandlerSseMethodDef,
  Integration,
  RawParams,
} from "../core/handlers.ts";

/** The second argument of a Next.js route handler. */
export interface NextRouteContext {
  /** The dynamic segments of the route. A promise since Next.js 15. */
  readonly params?: Promise<RawParams> | RawParams;
}

/**
 * The helpers typed with your request type, so that a handler sees
 * `nextUrl` and `cookies`: `withRequest<NextRequest>()`.
 */
export function withRequest<TRequest extends Request = Request>(): Integration<
  TRequest,
  [context?: NextRouteContext]
> {
  return defineIntegration<TRequest, [context?: NextRouteContext]>({
    request: (request) => request,
    params: (_request, context) => context?.params,
  });
}

/** The helpers of the Next.js integration, for a standard `Request`. */
export type NextIntegration = Integration<
  Request,
  [context?: NextRouteContext]
>;

const integration: NextIntegration = withRequest();

/** Define an API endpoint; the handler receives the request. */
export const endpoint: NextIntegration["endpoint"] = integration.endpoint;

/** Define an SSE endpoint; the generator receives the request. */
export const sseEndpoint: NextIntegration["sseEndpoint"] =
  integration.sseEndpoint;

/**
 * Create route handlers with automatic validation. Destructure the result
 * into the exports of `route.ts`: `export const { GET, POST } = ...`.
 */
export const createApiHandlers: NextIntegration["createApiHandlers"] =
  integration.createApiHandlers;

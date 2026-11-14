/**
 * SvelteKit Integration (`+server.ts` endpoints)
 *
 * - endpoint() / sseEndpoint() — define typed API methods
 * - createApiHandlers() — request handlers `(event) => Response`, to export
 *   by method name
 * - withEvent() — the same helpers typed with your `RequestEvent`
 *
 * @example
 * ```ts
 * // src/routes/api/users/[id]/+server.ts
 * import { z } from "zod";
 * import { createApiHandlers, endpoint } from "@dgellow/typed-endpoints/sveltekit";
 *
 * export const { GET } = createApiHandlers({
 *   GET: endpoint({
 *     params: z.object({ id: z.string() }),
 *     handler: (_event, { params }) => Response.json({ id: params.id }),
 *   }),
 * });
 * ```
 *
 * A `+server.ts` exports one function per HTTP method. The definitions for
 * the generators travel on those functions. Generate with the `sveltekit`
 * convention:
 * `generateTypes({ routesDirs: ["src/routes/api"], convention: "sveltekit" })`.
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

/** What this module reads from SvelteKit's `RequestEvent`. */
export interface SvelteKitEvent {
  /** The standard request. */
  readonly request: Request;
  /** The parameters of the matched route. */
  readonly params: Readonly<Record<string, string | undefined>>;
}

/**
 * The helpers typed with your event type, so that a handler sees `locals`
 * and `cookies`: `withEvent<RequestEvent>()`.
 */
export function withEvent<
  TEvent extends SvelteKitEvent = SvelteKitEvent,
>(): Integration<TEvent> {
  return defineIntegration<TEvent>({
    request: (event) => event.request,
    params: (event) => event.params,
  });
}

/** The helpers of the SvelteKit integration, for the minimal event. */
export type SvelteKitIntegration = Integration<SvelteKitEvent>;

const integration: SvelteKitIntegration = withEvent();

/** Define an API endpoint; the handler receives the request event. */
export const endpoint: SvelteKitIntegration["endpoint"] = integration.endpoint;

/** Define an SSE endpoint; the generator receives the request event. */
export const sseEndpoint: SvelteKitIntegration["sseEndpoint"] =
  integration.sseEndpoint;

/**
 * Create request handlers with automatic validation. Destructure the
 * result into the exports of `+server.ts`: `export const { GET } = ...`.
 */
export const createApiHandlers: SvelteKitIntegration["createApiHandlers"] =
  integration.createApiHandlers;

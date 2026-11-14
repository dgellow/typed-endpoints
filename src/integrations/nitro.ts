/**
 * Nitro and h3 Integration (h3 v2, Nitro v3)
 *
 * - endpoint() / sseEndpoint() — define typed API methods
 * - createHandler() — one event handler for a route file whose name states
 *   the method (`users/[id].get.ts`)
 * - createApiHandlers() — event handlers by method, for an h3 app
 * - withEvent() — the same helpers typed with your `H3Event`
 *
 * @example
 * ```ts
 * // server/api/users/[id].get.ts
 * import { z } from "zod";
 * import { createHandler, endpoint } from "@dgellow/typed-endpoints/nitro";
 *
 * export default createHandler(endpoint({
 *   params: z.object({ id: z.string() }),
 *   handler: (_event, { params }) => Response.json({ id: params.id }),
 * }));
 * ```
 *
 * The method of such a file is in its name, so the generators take it from
 * there. Generate with the `nitro` convention:
 * `generateTypes({ routesDirs: ["server/api"], convention: "nitro" })`.
 * A file without a method suffix answers every method and is left out of
 * generated output, which is by method.
 *
 * Requires h3 v2, where `event.req` is a standard `Request`. In h3 v1
 * (Nitro v2) it is not, and this module does not work there.
 *
 * @module
 */

import {
  defineIntegration,
  type Integration,
  type RouteHandler,
} from "../core/handlers.ts";

export type { SseEvent, SseEventDef, SseMethodDef } from "../core/types.ts";
export type {
  ApiDefOf,
  HandlerMethodDef,
  Handlers,
  HandlerSseMethodDef,
  Integration,
  RouteHandler,
} from "../core/handlers.ts";

/** What this module reads from h3's `H3Event` (v2). */
export interface H3EventLike {
  /** The standard request. */
  readonly req: Request;
  /** Per-request context; the router puts the path parameters here. */
  readonly context: {
    /** The parameters of the matched route. */
    readonly params?: Readonly<Record<string, string>>;
  };
}

/** The helpers of the Nitro integration. */
export interface NitroIntegration<TEvent extends H3EventLike>
  extends Integration<TEvent> {
  /**
   * Create the event handler of a route file whose name states the method.
   * The handler validates against the definition whatever method the
   * request has; a body is read for POST, PUT and PATCH.
   */
  createHandler<TDef extends { readonly handler: unknown }>(
    def: TDef,
  ): RouteHandler<TEvent, [], TDef>;
}

/**
 * The helpers typed with your event type, so that a handler sees what
 * your app puts on `event.context`: `withEvent<H3Event>()`.
 */
export function withEvent<
  TEvent extends H3EventLike = H3EventLike,
>(): NitroIntegration<TEvent> {
  const base = defineIntegration<TEvent>({
    request: (event) => event.req,
    params: (event) => event.context.params,
  }, { hiddenApiDef: true });

  return {
    ...base,
    createHandler<TDef extends { readonly handler: unknown }>(def: TDef) {
      // The definition does not say the method; the request does.
      const byMethod = new Map<string, (event: TEvent) => Promise<Response>>();
      const handler = (event: TEvent): Promise<Response> => {
        const method = event.req.method.toUpperCase();
        let handle = byMethod.get(method);
        if (!handle) {
          handle = base.createApiHandlers({ [method]: def })[method];
          byMethod.set(method, handle);
        }
        return handle(event);
      };

      const { handler: _, ...methodDef } = def;
      Object.defineProperty(handler, "__methodDef", { value: methodDef });
      return handler as RouteHandler<TEvent, [], TDef>;
    },
  };
}

/** The helpers of the Nitro integration, for the minimal event. */
export type DefaultNitroIntegration = NitroIntegration<H3EventLike>;

const integration: DefaultNitroIntegration = withEvent();

/** Define an API endpoint; the handler receives the h3 event. */
export const endpoint: DefaultNitroIntegration["endpoint"] =
  integration.endpoint;

/** Define an SSE endpoint; the generator receives the h3 event. */
export const sseEndpoint: DefaultNitroIntegration["sseEndpoint"] =
  integration.sseEndpoint;

/** Create the event handler of a route file whose name states the method. */
export const createHandler: DefaultNitroIntegration["createHandler"] =
  integration.createHandler;

/** Create event handlers with automatic validation, one per method. */
export const createApiHandlers: DefaultNitroIntegration["createApiHandlers"] =
  integration.createApiHandlers;

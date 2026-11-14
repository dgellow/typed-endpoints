/**
 * Fresh v2 Integration
 *
 * Runtime adapter for Deno Fresh v2. Provides endpoint definition helpers
 * and request handler creation with automatic Zod validation.
 *
 * - endpoint() / sseEndpoint() — define typed API methods
 * - createApiHandlers() — wrap methods into Fresh route handlers with validation
 *
 * The work is done by `core/handlers.ts`; this module fixes the context
 * type to Fresh's `Context`.
 *
 * @module
 */

import type { Context } from "@fresh/core";
import type { z } from "zod";
import type { SseEventDef } from "../core/types.ts";
import {
  buildHandlers,
  type HandlerMethodDef,
  type Handlers,
  type HandlerSseMethodDef,
} from "../core/handlers.ts";

export type { SseEvent, SseEventDef, SseMethodDef } from "../core/types.ts";
export type {
  ApiDefOf,
  HandlerMethodDef,
  HandlerResult,
  Handlers,
  HandlerSseMethodDef,
} from "../core/handlers.ts";

/** Fresh-specific method definition with handler */
export type FreshApiMethodDef<
  TState,
  TBodySchema extends z.ZodType | undefined = undefined,
  TQuerySchema extends z.ZodType | undefined = undefined,
  TParamsSchema extends z.ZodType | undefined = undefined,
  TResponseSchema extends z.ZodType | undefined = z.ZodType | undefined,
> = HandlerMethodDef<
  Context<TState>,
  TBodySchema,
  TQuerySchema,
  TParamsSchema,
  TResponseSchema
>;

/**
 * Define an API endpoint with full type inference for the handler.
 *
 * This wrapper is needed because TypeScript can't infer types between sibling
 * properties in an object literal. Without it, params/body/query in the handler
 * would be untyped. The wrapper creates an inference context that connects your
 * Zod schemas to the handler's validated parameter types.
 *
 * Zero runtime cost - this function just returns its argument unchanged.
 */
export function endpoint<
  TState,
  TBodySchema extends z.ZodType | undefined = undefined,
  TQuerySchema extends z.ZodType | undefined = undefined,
  TParamsSchema extends z.ZodType | undefined = undefined,
  TResponseSchema extends z.ZodType | undefined = undefined,
>(
  def: FreshApiMethodDef<
    TState,
    TBodySchema,
    TQuerySchema,
    TParamsSchema,
    TResponseSchema
  >,
): FreshApiMethodDef<
  TState,
  TBodySchema,
  TQuerySchema,
  TParamsSchema,
  TResponseSchema
> {
  return def;
}

// =============================================================================
// SSE Support
// =============================================================================

/** Fresh-specific SSE method definition with generator handler */
export type FreshSseMethodDef<
  TState,
  TQuerySchema extends z.ZodType | undefined = undefined,
  TParamsSchema extends z.ZodType | undefined = undefined,
  TEvents extends SseEventDef = SseEventDef,
> = HandlerSseMethodDef<Context<TState>, TQuerySchema, TParamsSchema, TEvents>;

/**
 * Define an SSE endpoint with full type inference.
 *
 * Zero runtime cost - returns argument unchanged, exists for type inference.
 *
 * @example
 * ```ts
 * createApiHandlers({
 *   GET: sseEndpoint({
 *     params: z.object({ id: z.string() }),
 *     events: {
 *       progress: z.object({ percent: z.number() }),
 *       complete: z.object({ result: z.string() }),
 *     },
 *     async *handler(ctx, { params }, signal) {
 *       yield { event: "progress", data: { percent: 50 } };
 *       yield { event: "complete", data: { result: "done" } };
 *     },
 *   }),
 * })
 * ```
 */
export function sseEndpoint<
  TState,
  TQuerySchema extends z.ZodType | undefined = undefined,
  TParamsSchema extends z.ZodType | undefined = undefined,
  TEvents extends SseEventDef = SseEventDef,
>(
  def: FreshSseMethodDef<TState, TQuerySchema, TParamsSchema, TEvents>,
): FreshSseMethodDef<TState, TQuerySchema, TParamsSchema, TEvents> {
  return def;
}

/** What `createApiHandlers()` returns: one handler per defined method. */
export type ApiHandlers<TState, TDef> = Handlers<Context<TState>, TDef>;

/**
 * Create Fresh route handlers with automatic validation.
 * Returns handlers compatible with Fresh's file-based routing.
 *
 * For full type inference in handlers, wrap each method with `endpoint()`:
 * ```ts
 * createApiHandlers({
 *   GET: endpoint({
 *     params: z.object({ id: z.string() }),
 *     handler: (ctx, { params }) => { ... } // params is typed!
 *   })
 * })
 * ```
 */
export function createApiHandlers<TState, TDef extends Record<string, unknown>>(
  apiDef: TDef,
): ApiHandlers<TState, TDef> {
  return buildHandlers<Context<TState>, TDef>(apiDef, {
    request: (ctx) => ctx.req,
    params: (ctx) => ctx.params as Record<string, string>,
  });
}

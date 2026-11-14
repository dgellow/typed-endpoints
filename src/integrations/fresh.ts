/**
 * Fresh v2 Integration
 *
 * Runtime adapter for Deno Fresh v2. Provides endpoint definition helpers
 * and request handler creation with automatic Zod validation.
 *
 * - endpoint() / sseEndpoint() — define typed API methods
 * - createApiHandlers() — wrap methods into Fresh route handlers with validation
 *
 * @module
 */

import type { Context } from "@fresh/core";
import type { z } from "zod";
import type {
  ApiMethodDef,
  HttpMethod,
  SseEvent,
  SseEventDef,
  SseMethodDef,
  ValidatedRequest,
} from "../core/types.ts";
import { validateRequest } from "../core/validation.ts";

export type { SseEvent, SseEventDef, SseMethodDef } from "../core/types.ts";

/** JSON error response */
function jsonError(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Fresh-specific method definition with handler */
export interface FreshApiMethodDef<
  TState,
  TBodySchema extends z.ZodType | undefined = undefined,
  TQuerySchema extends z.ZodType | undefined = undefined,
  TParamsSchema extends z.ZodType | undefined = undefined,
  TResponseSchema extends z.ZodType | undefined = z.ZodType | undefined,
> extends
  ApiMethodDef<TBodySchema, TQuerySchema, TParamsSchema, TResponseSchema> {
  /**
   * Handles the request. Receives the Fresh context and the validated
   * body, query and path parameters.
   */
  readonly handler: (
    ctx: Context<TState>,
    validated: ValidatedRequest<
      TBodySchema extends z.ZodType ? z.infer<TBodySchema> : unknown,
      TQuerySchema extends z.ZodType ? z.infer<TQuerySchema> : unknown,
      TParamsSchema extends z.ZodType ? z.infer<TParamsSchema> : unknown
    >,
  ) => Response | Promise<Response>;
}

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
export interface FreshSseMethodDef<
  TState,
  TQuerySchema extends z.ZodType | undefined = undefined,
  TParamsSchema extends z.ZodType | undefined = undefined,
  TEvents extends SseEventDef = SseEventDef,
> extends SseMethodDef<TQuerySchema, TParamsSchema, TEvents> {
  /**
   * Produces the events. Receives the Fresh context, the validated query
   * and path parameters, and a signal that aborts when the client
   * disconnects or the response body is cancelled.
   */
  readonly handler: (
    ctx: Context<TState>,
    validated: {
      query: TQuerySchema extends z.ZodType ? z.infer<TQuerySchema> : unknown;
      params: TParamsSchema extends z.ZodType ? z.infer<TParamsSchema>
        : unknown;
    },
    signal: AbortSignal,
  ) => AsyncGenerator<SseEvent<TEvents>, void, unknown>;
}

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

/** One event in `text/event-stream` framing. */
function formatSseEvent<TEvents extends SseEventDef>(
  event: SseEvent<TEvents>,
): string {
  let message = "";
  if (event.event) {
    message += `event: ${String(event.event)}\n`;
  }
  // An empty id is meaningful: it resets the client's last event ID.
  if (event.id !== undefined) {
    message += `id: ${event.id}\n`;
  }
  if (event.retry !== undefined) {
    message += `retry: ${event.retry}\n`;
  }
  return message + `data: ${JSON.stringify(event.data)}\n\n`;
}

/**
 * Create SSE response from async generator.
 *
 * The generator is advanced only when the consumer reads, and it stops
 * when the response body is cancelled or `abort` fires, whichever is first:
 * the handler's signal aborts and its `finally` blocks run.
 */
function createSseResponse<TEvents extends SseEventDef>(
  generator: AsyncGenerator<SseEvent<TEvents>, void, unknown>,
  abort: AbortController,
): Response {
  const encoder = new TextEncoder();
  const { signal } = abort;
  let finished = false;

  // Ends the generator once. A handler that throws while it winds down has
  // nowhere to report to, so the error is logged.
  const finish = () => {
    if (finished) return;
    finished = true;
    generator.return(undefined).catch((error) => {
      console.error("SSE stream error:", error);
    });
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = signal.aborted
          ? { done: true as const }
          : await generator.next();
        // The body was cancelled while the handler was working.
        if (finished) return;
        if (next.done || signal.aborted) {
          finish();
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(formatSseEvent(next.value)));
      } catch (error) {
        if (finished) return;
        finished = true;
        if (!signal.aborted) {
          console.error("SSE stream error:", error);
        }
        controller.close();
      }
    },
    cancel() {
      abort.abort();
      finish();
    },
    // Nothing is produced ahead of the consumer.
  }, { highWaterMark: 0 });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}

/** Check if a definition is an SSE endpoint */
function isSseEndpoint(def: unknown): boolean {
  return typeof def === "object" && def !== null && "events" in def;
}

/**
 * The method definitions of a route without their handlers, with the schema
 * types as written. Tooling reads the schemas from here at runtime; protocol
 * composition (`fromEndpoint()`) reads their types.
 */
export type ApiDefOf<TDef> = {
  readonly [M in keyof TDef]: Omit<TDef[M], "handler">;
};

/** What `createApiHandlers()` returns: one handler per defined method. */
export type ApiHandlers<TState, TDef> =
  & { [M in keyof TDef]: (ctx: Context<TState>) => Promise<Response> }
  & { __apiDef: ApiDefOf<TDef> };

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
  const handlers: Record<
    string,
    (ctx: Context<TState>) => Promise<Response>
  > = {};

  type MethodDef = FreshApiMethodDef<TState, z.ZodType, z.ZodType, z.ZodType>;
  type SseDef = FreshSseMethodDef<TState, z.ZodType, z.ZodType, SseEventDef>;

  for (const [method, def] of Object.entries(apiDef)) {
    if (!def) continue;

    // Handle SSE endpoints
    if (isSseEndpoint(def)) {
      const sseDef = def as SseDef;
      handlers[method] = async (ctx: Context<TState>) => {
        // Validate query and params only (SSE has no body)
        const result = await validateRequest(
          {
            json: () => Promise.resolve(undefined),
            url: ctx.req.url,
            params: ctx.params as Record<string, string>,
          },
          { query: sseDef.query, params: sseDef.params },
          "GET",
        );

        if (!result.success) {
          return jsonError(result.error, 400);
        }

        const abortController = new AbortController();

        // Clean up on client disconnect
        ctx.req.signal.addEventListener("abort", () => {
          abortController.abort();
        });

        const generator = sseDef.handler(
          ctx,
          { query: result.data.query, params: result.data.params },
          abortController.signal,
        );

        return createSseResponse(generator, abortController);
      };
    } else {
      // Handle regular REST endpoints
      const methodDef = def as MethodDef;
      handlers[method] = async (ctx: Context<TState>) => {
        const result = await validateRequest(
          {
            json: () => ctx.req.json(),
            url: ctx.req.url,
            params: ctx.params as Record<string, string>,
          },
          methodDef,
          method,
        );

        if (!result.success) {
          return jsonError(result.error, 400);
        }

        return await methodDef.handler(ctx, result.data);
      };
    }
  }

  // Attach apiDef for OpenAPI/type generation (strip handlers)
  // deno-lint-ignore no-explicit-any
  const apiDefWithoutHandlers: Record<string, any> = {};
  for (const [method, def] of Object.entries(apiDef)) {
    if (!def) continue;
    // deno-lint-ignore no-explicit-any
    const { handler: _, ...rest } = def as Record<string, any>;
    apiDefWithoutHandlers[method as HttpMethod] = rest;
  }

  return Object.assign(handlers, {
    __apiDef: apiDefWithoutHandlers,
  }) as ApiHandlers<TState, TDef>;
}

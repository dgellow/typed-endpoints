import type { Context } from "@fresh/core";
import type { z } from "zod";
import type {
  ApiDef,
  ApiMethodDef,
  HttpMethod,
  SseEvent,
  SseEventDef,
  SseMethodDef,
  ValidatedRequest,
} from "../core/types.ts";
import { validateRequest } from "../core/validation.ts";

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
> extends ApiMethodDef<TBodySchema, TQuerySchema, TParamsSchema> {
  handler: (
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
>(
  def: FreshApiMethodDef<TState, TBodySchema, TQuerySchema, TParamsSchema>,
): FreshApiMethodDef<TState, TBodySchema, TQuerySchema, TParamsSchema> {
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
  handler: (
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

/**
 * Create SSE response from async generator.
 */
function createSseResponse<TEvents extends SseEventDef>(
  generator: AsyncGenerator<SseEvent<TEvents>, void, unknown>,
  signal: AbortSignal,
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of generator) {
          if (signal.aborted) break;

          let message = "";
          if (event.event) {
            message += `event: ${String(event.event)}\n`;
          }
          if (event.id) {
            message += `id: ${event.id}\n`;
          }
          if (event.retry !== undefined) {
            message += `retry: ${event.retry}\n`;
          }
          message += `data: ${JSON.stringify(event.data)}\n\n`;

          controller.enqueue(encoder.encode(message));
        }
      } catch (error) {
        if (!signal.aborted) {
          console.error("SSE stream error:", error);
        }
      } finally {
        controller.close();
      }
    },
  });

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
): Record<string, (ctx: Context<TState>) => Promise<Response>> & {
  __apiDef: ApiDef;
} {
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

        return createSseResponse(generator, abortController.signal);
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

  return Object.assign(handlers, { __apiDef: apiDefWithoutHandlers });
}

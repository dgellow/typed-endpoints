import type { Context } from "@fresh/core";
import type { z } from "zod";
import type {
  ApiDef,
  ApiMethodDef,
  HttpMethod,
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

  for (const [method, def] of Object.entries(apiDef)) {
    if (!def) continue;
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

  // Attach apiDef for OpenAPI generation
  const apiDefWithoutHandlers: ApiDef = {};
  for (const [method, def] of Object.entries(apiDef)) {
    if (!def) continue;
    const methodDef = def as MethodDef;
    const { handler: _, ...rest } = methodDef;
    apiDefWithoutHandlers[method as HttpMethod] = rest;
  }

  return Object.assign(handlers, { __apiDef: apiDefWithoutHandlers });
}

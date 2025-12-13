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

export type FreshApiDef<TState> = {
  [M in HttpMethod]?: FreshApiMethodDef<
    TState,
    z.ZodType | undefined,
    z.ZodType | undefined,
    z.ZodType | undefined
  >;
};

/**
 * Create Fresh route handlers with automatic validation.
 * Returns handlers compatible with Fresh's file-based routing.
 */
export function createApiHandlers<TState, T extends FreshApiDef<TState>>(
  apiDef: T,
): Record<string, (ctx: Context<TState>) => Promise<Response>> & {
  __apiDef: ApiDef;
} {
  const handlers: Record<
    string,
    (ctx: Context<TState>) => Promise<Response>
  > = {};

  for (const [method, def] of Object.entries(apiDef)) {
    if (!def) continue;

    handlers[method] = async (ctx: Context<TState>) => {
      const result = await validateRequest(
        {
          json: () => ctx.req.json(),
          url: ctx.req.url,
          params: ctx.params as Record<string, string>,
        },
        def,
        method,
      );

      if (!result.success) {
        return jsonError(result.error, 400);
      }

      return await def.handler(ctx, result.data);
    };
  }

  // Attach apiDef for OpenAPI generation
  const apiDefWithoutHandlers: ApiDef = {};
  for (const [method, def] of Object.entries(apiDef)) {
    if (!def) continue;
    const { handler: _, ...rest } = def;
    apiDefWithoutHandlers[method as HttpMethod] = rest;
  }

  return Object.assign(handlers, { __apiDef: apiDefWithoutHandlers });
}

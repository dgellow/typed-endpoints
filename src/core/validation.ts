import type { z } from "zod";
import type { ApiMethodDef, ValidatedRequest } from "./types.ts";

export interface ValidationResult<TBody, TQuery, TParams> {
  success: true;
  data: ValidatedRequest<TBody, TQuery, TParams>;
}

export interface ValidationError {
  success: false;
  error: string;
  type: "body" | "query" | "params" | "json";
}

export type ValidationOutcome<TBody, TQuery, TParams> =
  | ValidationResult<TBody, TQuery, TParams>
  | ValidationError;

export interface RawRequest {
  json: () => Promise<unknown>;
  url: string;
  params?: Record<string, string>;
}

/**
 * Parse URLSearchParams preserving array values for duplicate keys.
 * Single values remain strings, duplicate keys become arrays.
 */
export function parseSearchParams(
  searchParams: URLSearchParams,
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const key of new Set(searchParams.keys())) {
    const values = searchParams.getAll(key);
    result[key] = values.length === 1 ? values[0] : values;
  }
  return result;
}

/**
 * Validates a request against an API method definition.
 * Framework-agnostic - works with any request that provides json(), url, and params.
 */
export async function validateRequest<
  TBodySchema extends z.ZodType | undefined,
  TQuerySchema extends z.ZodType | undefined,
  TParamsSchema extends z.ZodType | undefined,
>(
  req: RawRequest,
  def: ApiMethodDef<TBodySchema, TQuerySchema, TParamsSchema>,
  method: string,
): Promise<
  ValidationOutcome<
    TBodySchema extends z.ZodType ? z.infer<TBodySchema> : unknown,
    TQuerySchema extends z.ZodType ? z.infer<TQuerySchema> : unknown,
    TParamsSchema extends z.ZodType ? z.infer<TParamsSchema> : unknown
  >
> {
  // Validate body
  let body: unknown = undefined;
  if (def.body && ["POST", "PUT", "PATCH"].includes(method)) {
    let rawBody: unknown;
    try {
      rawBody = await req.json();
    } catch {
      return { success: false, error: "Invalid JSON body", type: "json" };
    }

    const result = def.body.safeParse(rawBody);
    if (!result.success) {
      const errors = result.error.issues
        .map((e) => `${e.path.join(".")}: ${e.message}`)
        .join(", ");
      return {
        success: false,
        error: `Validation error: ${errors}`,
        type: "body",
      };
    }
    body = result.data;
  }

  // Validate query
  let query: unknown = undefined;
  if (def.query) {
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return { success: false, error: "Invalid request URL", type: "query" };
    }
    const rawQuery = parseSearchParams(url.searchParams);
    const result = def.query.safeParse(rawQuery);
    if (!result.success) {
      const errors = result.error.issues
        .map((e) => `${e.path.join(".")}: ${e.message}`)
        .join(", ");
      return {
        success: false,
        error: `Query validation error: ${errors}`,
        type: "query",
      };
    }
    query = result.data;
  }

  // Validate params
  let params: unknown = req.params;
  if (def.params) {
    const result = def.params.safeParse(req.params);
    if (!result.success) {
      const errors = result.error.issues
        .map((e) => `${e.path.join(".")}: ${e.message}`)
        .join(", ");
      return {
        success: false,
        error: `Params validation error: ${errors}`,
        type: "params",
      };
    }
    params = result.data;
  }

  return {
    success: true,
    data: { body, query, params } as ValidatedRequest<
      TBodySchema extends z.ZodType ? z.infer<TBodySchema> : unknown,
      TQuerySchema extends z.ZodType ? z.infer<TQuerySchema> : unknown,
      TParamsSchema extends z.ZodType ? z.infer<TParamsSchema> : unknown
    >,
  };
}

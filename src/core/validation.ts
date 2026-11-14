import type { z } from "zod";
import type { ApiMethodDef, ValidatedRequest } from "./types.ts";
import {
  isOptionalField,
  unwrapSchema,
  zodDef,
  zodType,
} from "./zod_internals.ts";

/** Format Zod validation errors into a readable string */
function formatZodErrors(error: z.ZodError): string {
  return error.issues
    // An issue at the root has no path to prefix.
    .map((e) =>
      e.path.length > 0 ? `${e.path.join(".")}: ${e.message}` : e.message
    )
    .join(", ");
}

export interface ValidationResult<TBody, TQuery, TParams> {
  readonly success: true;
  readonly data: ValidatedRequest<TBody, TQuery, TParams>;
}

export interface ValidationError {
  readonly success: false;
  readonly error: string;
  readonly type: "body" | "query" | "params" | "json";
}

export type ValidationOutcome<TBody, TQuery, TParams> =
  | ValidationResult<TBody, TQuery, TParams>
  | ValidationError;

export interface RawRequest {
  readonly json: () => Promise<unknown>;
  readonly url: string;
  readonly params?: Record<string, string>;
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

// A query string cannot say whether `?tag=a` is a string or a one-element
// list, and cannot express an empty list at all. The schema knows which one
// is meant, so the raw query is shaped by it before validation.

/**
 * Shape raw query values by the query schema: a field declared as a list
 * receives a list for zero, one or several occurrences of its key.
 *
 * Scalar fields are left as parsed, so a scalar key that occurs several
 * times still fails validation with a message naming the field.
 */
export function shapeQueryBySchema(
  raw: Record<string, string | string[]>,
  schema: unknown,
): Record<string, string | string[]> {
  const root = zodDef(unwrapSchema(schema, "input"));
  if (root.type !== "object") return raw;

  const result = { ...raw };
  for (
    const [key, field] of Object.entries(root.shape as Record<string, unknown>)
  ) {
    const type = zodType(unwrapSchema(field, "input"));
    if (type !== "array" && type !== "set") continue;

    const value = raw[key];
    if (typeof value === "string") {
      result[key] = [value];
    } else if (value === undefined && !isOptionalField(field, "input")) {
      result[key] = [];
    }
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
      return {
        success: false,
        error: `Validation error: ${formatZodErrors(result.error)}`,
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
    const rawQuery = shapeQueryBySchema(
      parseSearchParams(url.searchParams),
      def.query,
    );
    const result = def.query.safeParse(rawQuery);
    if (!result.success) {
      return {
        success: false,
        error: `Query validation error: ${formatZodErrors(result.error)}`,
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
      return {
        success: false,
        error: `Params validation error: ${formatZodErrors(result.error)}`,
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

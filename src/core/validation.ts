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

/** A request that passed validation. */
export interface ValidationResult<TBody, TQuery, TParams> {
  /** Discriminant: validation passed. */
  readonly success: true;
  /** The parsed body, query and path parameters. */
  readonly data: ValidatedRequest<TBody, TQuery, TParams>;
}

/** One thing a request got wrong, as the schema reports it. */
export interface ValidationIssue {
  /** Where in the body, query or path parameters; empty for the root. */
  readonly path: readonly (string | number)[];
  /** What is wrong there. */
  readonly message: string;
  /** Zod's issue code, e.g. `invalid_type`, `too_small`. */
  readonly code: string;
}

/** A request that failed validation. */
export interface ValidationError {
  /** Discriminant: validation failed. */
  readonly success: false;
  /** Message that lists each failing field. */
  readonly error: string;
  /**
   * The part that failed. `"json"`: the body is not valid JSON.
   * `"content-type"`: the body is not JSON and its content type says so.
   */
  readonly type: "body" | "query" | "params" | "json" | "content-type";
  /** Each failing field. Empty for `"json"` and `"content-type"`. */
  readonly issues: readonly ValidationIssue[];
}

/** Result of `validateRequest()`. */
export type ValidationOutcome<TBody, TQuery, TParams> =
  | ValidationResult<TBody, TQuery, TParams>
  | ValidationError;

/** The parts of a request that validation reads. Not tied to a framework. */
export interface RawRequest {
  /** Reads and parses the JSON body. */
  readonly json: () => Promise<unknown>;
  /**
   * Reads the body as text. When given, it is used instead of `json`, and
   * a request without a body is validated as `undefined`, which a schema
   * that allows no body accepts.
   */
  readonly text?: () => Promise<string>;
  /** Value of the `Content-Type` header, if the request has one. */
  readonly contentType?: string | null;
  /** Full request URL. The query string is read from it. */
  readonly url: string;
  /** Path parameters, as the router extracted them. */
  readonly params?: Record<string, string>;
}

function issuesOf(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.filter((part) => typeof part !== "symbol") as (
      | string
      | number
    )[],
    message: issue.message,
    code: issue.code ?? "custom",
  }));
}

/**
 * Whether a body with this `Content-Type` is taken to be meant as JSON.
 *
 * No value and `text/plain` count: `fetch()` sends a string body as
 * `text/plain` unless told otherwise, so a client that forgot the header
 * is told its JSON is malformed, not that its content type is wrong.
 */
function meantAsJson(contentType: string | null | undefined): boolean {
  if (!contentType) return true;
  const mediaType = contentType.split(";")[0].trim().toLowerCase();
  return mediaType === "application/json" || mediaType.endsWith("+json") ||
    mediaType === "text/plain";
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
  // Validate body, for every method that can carry one. GET and HEAD
  // requests cannot: a body schema there is not read.
  let body: unknown = undefined;
  if (def.body && method !== "GET" && method !== "HEAD") {
    let rawBody: unknown;
    try {
      if (req.text) {
        const text = await req.text();
        rawBody = text.trim() === "" ? undefined : JSON.parse(text);
      } else {
        rawBody = await req.json();
      }
    } catch {
      // A body that is not JSON and does not claim to be: say which
      // content type was sent, not that the JSON is malformed.
      return meantAsJson(req.contentType)
        ? {
          success: false,
          error: "Invalid JSON body",
          type: "json",
          issues: [],
        }
        : {
          success: false,
          error:
            `Unsupported content type "${req.contentType}": the body has to be JSON`,
          type: "content-type",
          issues: [],
        };
    }

    const result = def.body.safeParse(rawBody);
    if (!result.success) {
      return {
        success: false,
        error: `Validation error: ${formatZodErrors(result.error)}`,
        type: "body",
        issues: issuesOf(result.error),
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
      return {
        success: false,
        error: "Invalid request URL",
        type: "query",
        issues: [],
      };
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
        issues: issuesOf(result.error),
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
        issues: issuesOf(result.error),
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

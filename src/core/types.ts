import type { z } from "zod";
import type { AnyPaginationMeta } from "../pagination/types.ts";

// Re-export pagination types for convenience
export type {
  AnyPaginationMeta,
  CursorIdPaginationMeta,
  CursorPaginationMeta,
  OffsetPaginationMeta,
  PagePaginationMeta,
  PaginationStyle,
  UrlPaginationMeta,
} from "../pagination/types.ts";

/** HTTP methods a route file can define. */
export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "DELETE"
  | "PATCH"
  | "HEAD"
  | "OPTIONS";

/** The parsed parts of a request, as a handler receives them. */
export interface ValidatedRequest<
  TBody = unknown,
  TQuery = unknown,
  TParams = unknown,
> {
  /** Request body, parsed by the `body` schema. */
  readonly body: TBody;
  /** Query string, parsed by the `query` schema. */
  readonly query: TQuery;
  /** Path parameters, parsed by the `params` schema. */
  readonly params: TParams;
}

/** Schemas and metadata of one HTTP method of a route. */
export interface ApiMethodDef<
  TBodySchema extends z.ZodType | undefined = undefined,
  TQuerySchema extends z.ZodType | undefined = undefined,
  TParamsSchema extends z.ZodType | undefined = undefined,
  TResponseSchema extends z.ZodType | undefined = z.ZodType | undefined,
> {
  /** Schema of the JSON request body. Read for POST, PUT and PATCH only. */
  readonly body?: TBodySchema;
  /**
   * Schema of the query string. A field declared as an array or set
   * receives a list for zero, one or several occurrences of its key.
   */
  readonly query?: TQuerySchema;
  /** Schema of the path parameters. */
  readonly params?: TParamsSchema;
  /**
   * Schema of the 200 response body. Used for the generated types and the
   * OpenAPI spec; the value a handler returns is not checked against it.
   */
  readonly response?: TResponseSchema;
  /** Component name of the response schema in the OpenAPI spec. */
  readonly responseName?: string;
  /** Component name of the body schema in the OpenAPI spec. */
  readonly bodyName?: string;
  /**
   * Response schemas by status code, for the OpenAPI spec. `{ schema, name }`
   * registers the schema as a named component.
   */
  readonly responses?: Record<
    number,
    z.ZodType | { schema: z.ZodType; name?: string }
  >;
  /** Include this method in the OpenAPI spec. Default: false. */
  readonly public?: boolean;
  /** Summary of the OpenAPI operation. */
  readonly summary?: string;
  /** Description of the OpenAPI operation. */
  readonly description?: string;
  /** Tags of the OpenAPI operation. */
  readonly tags?: readonly string[];
  /** Operation ID for protocol step mapping and route generation */
  readonly operationId?: string;
  /** Pagination metadata (set by pagination helpers) */
  readonly __pagination?: AnyPaginationMeta;
}

/** The method definitions of one route, by HTTP method. */
export type ApiDef = {
  [M in HttpMethod]?: ApiMethodDef<
    z.ZodType | undefined,
    z.ZodType | undefined,
    z.ZodType | undefined
  >;
};

/** Infer body type from schema */
export type InferBody<T extends ApiMethodDef> = T["body"] extends z.ZodType
  ? z.infer<T["body"]>
  : unknown;

/** Infer query type from schema */
export type InferQuery<T extends ApiMethodDef> = T["query"] extends z.ZodType
  ? z.infer<T["query"]>
  : unknown;

/** Infer params type from schema */
export type InferParams<T extends ApiMethodDef> = T["params"] extends z.ZodType
  ? z.infer<T["params"]>
  : unknown;

// =============================================================================
// SSE Types
// =============================================================================

/** SSE event definitions - maps event names to Zod schemas */
export type SseEventDef = Record<string, z.ZodType>;

/** SSE method definition */
export interface SseMethodDef<
  TQuerySchema extends z.ZodType | undefined = undefined,
  TParamsSchema extends z.ZodType | undefined = undefined,
  TEvents extends SseEventDef = SseEventDef,
> {
  /** Schema of the query string. */
  readonly query?: TQuerySchema;
  /** Schema of the path parameters. */
  readonly params?: TParamsSchema;
  /** Data schema of each event, by event name. */
  readonly events: TEvents;
  /** Include this method in the OpenAPI spec. Default: false. */
  readonly public?: boolean;
  /** Summary of the OpenAPI operation. */
  readonly summary?: string;
  /** Description of the OpenAPI operation. */
  readonly description?: string;
  /** Tags of the OpenAPI operation. */
  readonly tags?: readonly string[];
  /** Operation ID for protocol step mapping and route generation */
  readonly operationId?: string;
}

/** Typed SSE event for handlers - discriminated union of all event types */
export type SseEvent<TEvents extends SseEventDef> = {
  [K in keyof TEvents]: {
    event: K;
    data: z.infer<TEvents[K]>;
    id?: string;
    retry?: number;
  };
}[keyof TEvents];

/** Infer SSE events union from method def */
export type InferSseEvents<T extends SseMethodDef> = SseEvent<T["events"]>;

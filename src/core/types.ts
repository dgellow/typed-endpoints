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

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "DELETE"
  | "PATCH"
  | "HEAD"
  | "OPTIONS";

export interface ValidatedRequest<
  TBody = unknown,
  TQuery = unknown,
  TParams = unknown,
> {
  body: TBody;
  query: TQuery;
  params: TParams;
}

export interface ApiMethodDef<
  TBodySchema extends z.ZodType | undefined = undefined,
  TQuerySchema extends z.ZodType | undefined = undefined,
  TParamsSchema extends z.ZodType | undefined = undefined,
> {
  body?: TBodySchema;
  query?: TQuerySchema;
  params?: TParamsSchema;
  response?: z.ZodType;
  responseName?: string;
  bodyName?: string;
  responses?: Record<number, z.ZodType | { schema: z.ZodType; name?: string }>;
  public?: boolean;
  summary?: string;
  description?: string;
  tags?: string[];
  /** Operation ID for protocol step mapping and route generation */
  operationId?: string;
  /** Pagination metadata (set by pagination helpers) */
  __pagination?: AnyPaginationMeta;
}

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
  query?: TQuerySchema;
  params?: TParamsSchema;
  events: TEvents;
  public?: boolean;
  summary?: string;
  description?: string;
  tags?: string[];
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

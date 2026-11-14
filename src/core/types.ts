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
  readonly body: TBody;
  readonly query: TQuery;
  readonly params: TParams;
}

export interface ApiMethodDef<
  TBodySchema extends z.ZodType | undefined = undefined,
  TQuerySchema extends z.ZodType | undefined = undefined,
  TParamsSchema extends z.ZodType | undefined = undefined,
  TResponseSchema extends z.ZodType | undefined = z.ZodType | undefined,
> {
  readonly body?: TBodySchema;
  readonly query?: TQuerySchema;
  readonly params?: TParamsSchema;
  readonly response?: TResponseSchema;
  readonly responseName?: string;
  readonly bodyName?: string;
  readonly responses?: Record<
    number,
    z.ZodType | { schema: z.ZodType; name?: string }
  >;
  readonly public?: boolean;
  readonly summary?: string;
  readonly description?: string;
  readonly tags?: string[];
  /** Operation ID for protocol step mapping and route generation */
  readonly operationId?: string;
  /** Pagination metadata (set by pagination helpers) */
  readonly __pagination?: AnyPaginationMeta;
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
  readonly query?: TQuerySchema;
  readonly params?: TParamsSchema;
  readonly events: TEvents;
  readonly public?: boolean;
  readonly summary?: string;
  readonly description?: string;
  readonly tags?: string[];
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

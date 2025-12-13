import type { z } from "zod";

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

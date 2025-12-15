/**
 * Type definitions for the typed client.
 *
 * Generated Api type structure:
 *
 * ```typescript
 * interface Api {
 *   users: {
 *     list: { response: User[] };
 *     retrieve: { params: { id: string }; response: User };
 *     create: { body: CreateUserBody; response: User };
 *     delete: { params: { id: string } };
 *   };
 *   webhooks: {
 *     stripe: {
 *       create: { body: StripeEvent; response: { received: boolean } };
 *     };
 *   };
 * }
 * ```
 */

/** Standard resource methods */
export type ResourceMethod =
  | "list"
  | "retrieve"
  | "create"
  | "update"
  | "delete";

/** Definition for a single method */
export interface MethodDef {
  params?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
  response?: unknown;
}

/** A resource can have methods and/or nested resources */
// deno-lint-ignore no-explicit-any
export type ResourceDef = Record<string, any>;

/** The full API schema - any object mapping resource names to definitions */
// deno-lint-ignore no-explicit-any
export type ApiSchema = Record<string, any>;

// =============================================================================
// Client method signatures
// =============================================================================

/** Options that can be passed to any method */
export interface RequestOptions {
  query?: Record<string, unknown>;
  signal?: AbortSignal;
}

/** List method - no required params, returns array */
export type ListMethod<M extends MethodDef> = M["query"] extends
  Record<string, unknown>
  ? (options: RequestOptions & { query: M["query"] }) => Promise<M["response"]>
  : (options?: RequestOptions) => Promise<M["response"]>;

/** Retrieve method - requires id param */
export type RetrieveMethod<M extends MethodDef> = (
  id: string,
  options?: RequestOptions,
) => Promise<M["response"]>;

/** Create method - requires body */
export type CreateMethod<M extends MethodDef> = M["body"] extends undefined
  ? (options?: RequestOptions) => Promise<M["response"]>
  : (body: M["body"], options?: RequestOptions) => Promise<M["response"]>;

/** Update method - requires id and body */
export type UpdateMethod<M extends MethodDef> = M["body"] extends undefined
  ? (id: string, options?: RequestOptions) => Promise<M["response"]>
  : (
    id: string,
    body: M["body"],
    options?: RequestOptions,
  ) => Promise<M["response"]>;

/** Delete method - requires id */
export type DeleteMethod<M extends MethodDef> = (
  id: string,
  options?: RequestOptions,
) => Promise<M["response"]>;

// =============================================================================
// Resource to Client type mapping
// =============================================================================

// deno-lint-ignore ban-types
type Empty = {};

/** Convert a ResourceDef to client methods */
export type ResourceClient<R extends ResourceDef> =
  // Methods
  & (R["list"] extends MethodDef ? { list: ListMethod<R["list"]> } : Empty)
  & (R["retrieve"] extends MethodDef
    ? { retrieve: RetrieveMethod<R["retrieve"]> }
    : Empty)
  & (R["create"] extends MethodDef ? { create: CreateMethod<R["create"]> }
    : Empty)
  & (R["update"] extends MethodDef ? { update: UpdateMethod<R["update"]> }
    : Empty)
  & (R["delete"] extends MethodDef ? { delete: DeleteMethod<R["delete"]> }
    : Empty)
  & // Nested resources (exclude method names)
  {
    [K in Exclude<keyof R, ResourceMethod>]: R[K] extends ResourceDef
      ? ResourceClient<R[K]>
      : never;
  };

/** The typed client - maps each top-level resource to its client */
export type TypedClient<Api extends ApiSchema> = {
  [K in keyof Api]: Api[K] extends ResourceDef ? ResourceClient<Api[K]> : never;
};

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
  /** Path parameter types. */
  readonly params?: Record<string, string>;
  /** Query parameter types. */
  readonly query?: Record<string, unknown>;
  /** Request body type. */
  readonly body?: unknown;
  /** Response body type. */
  readonly response?: unknown;
  /**
   * Set by the type generator when `response` contains `Dependent` places:
   * the response type of a call is computed from its options.
   */
  readonly dependent?: true;
}

/** A resource can have methods and/or nested resources */
// deno-lint-ignore no-explicit-any
export type ResourceDef = Record<string, any>;

/** The full API schema - any object mapping resource names to definitions */
// deno-lint-ignore no-explicit-any
export type ApiSchema = Record<string, any>;

import type { ReadonlyDeep, Resolve } from "../core/dependent_types.ts";

// =============================================================================
// Client method signatures
// =============================================================================

/** Options that can be passed to any method */
export interface RequestOptions {
  /** Query parameters, serialised into the URL. */
  readonly query?: Record<string, unknown>;
  /** Aborts the request. */
  readonly signal?: AbortSignal;
}

/**
 * Options for a method. When the method definition declares a `query` type,
 * `query` is typed by it; it is required only if it has required keys.
 */
export type MethodOptions<M> = M extends { query: infer Q } ?
    & Omit<RequestOptions, "query">
    & (Record<never, never> extends Q ? { query?: Q } : { query: Q })
  : RequestOptions;

/** The trailing options argument of a method. */
export type OptionsArg<M> = M extends { query: infer Q }
  ? Record<never, never> extends Q ? [options?: MethodOptions<M>]
  : [options: MethodOptions<M>]
  : [options?: RequestOptions];

/**
 * The trailing options argument of a method whose response type depends
 * on it: the options are captured as the type `O`.
 */
export type CapturedOptionsArg<M, O> = M extends { query: infer Q }
  ? Record<never, never> extends Q ? [options?: O]
  : [options: O]
  : [options?: O];

/**
 * A client method with leading arguments `TLead`.
 *
 * For an endpoint marked `dependent`, the method is generic in its options
 * and the response type is computed from them: `Resolve` applies the
 * families in the response type to the type of the options the call
 * passes. The options are captured with `const`, so a list written in the
 * call is a tuple whose members are known, and a list computed elsewhere
 * is an array whose members are not. Any other endpoint has the fixed
 * response type.
 */
export type Method<M extends MethodDef, TLead extends unknown[]> = M extends
  { dependent: true } ? <const O extends ReadonlyDeep<MethodOptions<M>>>(
    ...args: [...TLead, ...CapturedOptionsArg<M, O>]
  ) => Promise<Resolve<M["response"], O>>
  : (...args: [...TLead, ...OptionsArg<M>]) => Promise<M["response"]>;

/** List method - no required params, returns array */
export type ListMethod<M extends MethodDef> = Method<M, []>;

/** Retrieve method - requires id param */
export type RetrieveMethod<M extends MethodDef> = Method<M, [id: string]>;

/** Create method - requires body */
export type CreateMethod<M extends MethodDef> = M["body"] extends undefined
  ? Method<M, []>
  : Method<M, [body: M["body"]]>;

/** Update method - requires id and body */
export type UpdateMethod<M extends MethodDef> = M["body"] extends undefined
  ? Method<M, [id: string]>
  : Method<M, [id: string, body: M["body"]]>;

/** Delete method - requires id */
export type DeleteMethod<M extends MethodDef> = Method<M, [id: string]>;

// =============================================================================
// SSE Types
// =============================================================================

/** SSE events definition for generated types */
export interface SseEventsDef {
  /** Data type of each event, by event name. */
  readonly [eventName: string]: unknown;
}

/** SSE method definition in generated Api interface */
export interface SseMethodDef {
  /** Path parameter types. */
  readonly params?: Record<string, string>;
  /** Query parameter types. */
  readonly query?: Record<string, unknown>;
  /** Event data types, by event name. */
  readonly events: SseEventsDef;
}

/** Options for SSE subscription */
export interface SubscribeOptions {
  /** Query parameters, serialised into the URL. */
  readonly query?: Record<string, unknown>;
  /** Ends the subscription and closes the connection. */
  readonly signal?: AbortSignal;
  /**
   * Reconnect after a network failure or a 5xx response. Default: true.
   *
   * Not retried: 4xx responses and events whose data is not valid JSON.
   * A stream that the server closes normally ends the iteration.
   */
  readonly reconnect?: boolean;
  /**
   * Reconnect delay in ms, multiplied by the attempt number. Default: 1000.
   * A `retry` field sent by the server replaces it.
   */
  readonly reconnectDelay?: number;
  /** Max reconnect attempts. Default: 5 */
  readonly maxReconnectAttempts?: number;
}

/** Typed SSE event from subscription */
export type TypedSseEvent<TEvents extends SseEventsDef> = {
  [K in keyof TEvents]: {
    event: K;
    data: TEvents[K];
    id?: string;
  };
}[keyof TEvents];

/** Subscribe method - with or without id based on params */
export type SubscribeMethod<M extends SseMethodDef> = M["params"] extends
  Record<string, string> ? (
    id: string,
    options?: SubscribeOptions,
  ) => AsyncIterable<TypedSseEvent<M["events"]>>
  : (options?: SubscribeOptions) => AsyncIterable<TypedSseEvent<M["events"]>>;

// =============================================================================
// Resource to Client type mapping
// =============================================================================

/** A type with no keys: what a method or resource that is absent adds. */
// deno-lint-ignore ban-types
export type Empty = {};

/** Convert a ResourceDef to client methods */
export type ResourceClient<R extends ResourceDef> =
  // REST Methods
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
  // SSE Method
  & (R["subscribe"] extends SseMethodDef
    ? { subscribe: SubscribeMethod<R["subscribe"]> }
    : Empty)
  & // Nested resources (exclude method names)
  {
    [K in Exclude<keyof R, ResourceMethod | "subscribe">]: R[K] extends
      ResourceDef ? ResourceClient<R[K]>
      : never;
  };

/** The typed client - maps each top-level resource to its client */
export type TypedClient<Api extends ApiSchema> = {
  [K in keyof Api]: Api[K] extends ResourceDef ? ResourceClient<Api[K]> : never;
};

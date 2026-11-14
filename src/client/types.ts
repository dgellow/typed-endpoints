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
  | "replace"
  | "delete";

/** Definition for a single method */
export interface MethodDef {
  /**
   * Path template, e.g. `/api/users/{id}/posts`. Written by the type
   * generator; it says which path parameters a call has to supply.
   */
  readonly path?: string;
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
  /**
   * Pagination metadata, written by the type generator for an endpoint
   * built with a pagination helper: the style, and the names of the
   * fields and parameters it uses.
   */
  readonly pagination?: { readonly style: string; readonly items: string };
}

/** A resource can have methods and/or nested resources */
// deno-lint-ignore no-explicit-any
export type ResourceDef = Record<string, any>;

/** The full API schema - any object mapping resource names to definitions */
// deno-lint-ignore no-explicit-any
export type ApiSchema = Record<string, any>;

import type {
  ReadonlyDeep,
  Requires,
  Resolve,
} from "../core/dependent_types.ts";

// =============================================================================
// Client method signatures
// =============================================================================

/** Options that can be passed to any method */
export interface RequestOptions {
  /** Query parameters, serialised into the URL. */
  readonly query?: Record<string, unknown>;
  /** Aborts the request. */
  readonly signal?: AbortSignal;
  /**
   * Values for the path parameters that are not the trailing id, e.g.
   * `{ id }` for `/users/{id}/posts`. Needs the generated route table
   * (`createClient({ routes })`).
   */
  readonly params?: Readonly<Record<string, string>>;
}

// -----------------------------------------------------------------------------
// Path templates
// -----------------------------------------------------------------------------

/** `+name` (a catch-all) to `name`. */
export type ParamName<N extends string> = N extends `+${infer M}` ? M : N;

/**
 * Names of the parameters of a path template: `"id" | "postId"` for
 * `/users/{id}/posts/{postId}`. A catch-all is written `{+path}`.
 */
export type PathParamNames<P extends string> = P extends
  `${string}{${infer N}}${infer R}` ? ParamName<N> | PathParamNames<R>
  : never;

/**
 * The parameter that is the last segment of a path template, if the path
 * ends with one: `"postId"` for `/users/{id}/posts/{postId}`, `never` for
 * `/users/{id}/posts`.
 */
export type TrailingParam<P extends string> = P extends `${string}/{${infer N}}`
  ? N extends `${string}}${infer R}` ? TrailingParam<`${R}}`> : ParamName<N>
  : never;

/** The path template of a method definition; `never` if it has none. */
export type PathOf<M> = M extends { readonly path: infer P extends string } ? P
  : never;

/**
 * The leading `id` argument of a method that addresses one resource.
 *
 * With a path template, there is an id exactly when the path ends with a
 * parameter (`DELETE /session` has none). Without one, as in hand-written
 * definitions, the id is assumed.
 */
export type IdArg<M> = [PathOf<M>] extends [never] ? [id: string]
  : [TrailingParam<PathOf<M>>] extends [never] ? []
  : [id: string];

/** Path parameters a call passes in `options.params`: all of them. */
export type AllParams<M> = PathParamNames<PathOf<M>>;

/** Path parameters a call passes in `options.params`: all but the id. */
export type ParentParams<M> = Exclude<
  AllParams<M>,
  TrailingParam<PathOf<M>>
>;

/**
 * The `params` option for the path parameters `TNames`: required, typed by
 * the endpoint's `params` schema where it has one.
 */
export type ParamsOption<M, TNames extends string> = [TNames] extends [never]
  ? unknown
  : {
    readonly params: {
      readonly [K in TNames]: M extends { params: infer T }
        ? K extends keyof T ? T[K] : string
        : string;
    };
  };

// -----------------------------------------------------------------------------
// Options
// -----------------------------------------------------------------------------

/**
 * Options for a method. When the method definition declares a `query` type,
 * `query` is typed by it; it is required only if it has required keys.
 * `TNames` are the path parameters the call has to supply in `params`.
 */
export type MethodOptions<M, TNames extends string = never> =
  & (M extends { query: infer Q } ?
      & Omit<RequestOptions, "query" | "params">
      & (Record<never, never> extends Q ? { query?: Q } : { query: Q })
    : Omit<RequestOptions, "params">)
  & ParamsOption<M, TNames>;

/** Whether a call has to pass options: a required query, or path params. */
export type NeedsOptions<M, TNames extends string = never> = [TNames] extends
  [never]
  ? M extends { query: infer Q } ? Record<never, never> extends Q ? false : true
  : false
  : true;

/** The trailing options argument of a method. */
export type OptionsArg<M, TNames extends string = never> =
  NeedsOptions<M, TNames> extends true ? [options: MethodOptions<M, TNames>]
    : [options?: MethodOptions<M, TNames>];

/**
 * The trailing options argument of a method whose response type depends
 * on it: the options are captured as the type `O`.
 */
export type CapturedOptionsArg<M, O, TNames extends string = never> =
  NeedsOptions<M, TNames> extends true ? [options: O] : [options?: O];

/**
 * A client method with leading arguments `TLead` and path parameters
 * `TNames` to pass in `options.params`.
 *
 * For an endpoint marked `dependent`, the method is generic in its options
 * and the response type is computed from them: `Resolve` applies the
 * families in the response type to the type of the options the call
 * passes. The options are captured with `const`, so a list written in the
 * call is a tuple whose members are known, and a list computed elsewhere
 * is an array whose members are not. Any other endpoint has the fixed
 * response type.
 *
 * The options also have to meet what the families require of them
 * (`Requires`): a select string that names an unknown property is rejected
 * at the call, with the reason in the error.
 */
export type Method<
  M extends MethodDef,
  TLead extends unknown[],
  TNames extends string = never,
> = M extends { dependent: true }
  ? <const O extends ReadonlyDeep<MethodOptions<M, TNames>>>(
    ...args: [
      ...TLead,
      ...CapturedOptionsArg<M, O & Requires<M["response"], O>, TNames>,
    ]
  ) => Promise<Resolve<M["response"], O>>
  : (...args: [...TLead, ...OptionsArg<M, TNames>]) => Promise<M["response"]>;

/**
 * The element type of the list at the dot-notation path `P` of `T`;
 * `never` when there is no list there.
 */
export type ElementAt<T, P extends string> = P extends `${infer H}.${infer R}`
  ? H extends keyof T ? ElementAt<T[H], R> : never
  : P extends keyof T ? T[P] extends readonly (infer E)[] ? E : never
  : never;

/** The item type of a paginated method whose response type is `TResponse`. */
export type ItemOf<M, TResponse> = M extends
  { readonly pagination: { readonly items: infer P extends string } }
  ? ElementAt<TResponse, P>
  : never;

/**
 * What a `list` method of a paginated endpoint has besides being callable:
 * every page, or every item, from the page the options ask for onwards.
 *
 * The client asks for the next page the way the endpoint's pagination
 * style says (the cursor of the last response, the next offset or page
 * number, the id of the last item, the next URL) until the server says
 * there is none. Pages are requested as they are consumed: leaving the
 * loop stops the requests.
 *
 * For an endpoint without pagination metadata this adds nothing.
 */
export type Paginated<M extends MethodDef, TNames extends string = never> =
  M extends { readonly pagination: object } ? M extends { dependent: true } ? {
        /** Every page, in order. */
        pages<const O extends ReadonlyDeep<MethodOptions<M, TNames>>>(
          ...args: CapturedOptionsArg<
            M,
            O & Requires<M["response"], O>,
            TNames
          >
        ): AsyncIterable<Resolve<M["response"], O>>;
        /** Every item of every page, in order. */
        items<const O extends ReadonlyDeep<MethodOptions<M, TNames>>>(
          ...args: CapturedOptionsArg<
            M,
            O & Requires<M["response"], O>,
            TNames
          >
        ): AsyncIterable<ItemOf<M, Resolve<M["response"], O>>>;
      }
    : {
      /** Every page, in order. */
      pages(...args: OptionsArg<M, TNames>): AsyncIterable<M["response"]>;
      /** Every item of every page, in order. */
      items(
        ...args: OptionsArg<M, TNames>
      ): AsyncIterable<ItemOf<M, M["response"]>>;
    }
    : unknown;

/** List method - no id, returns array */
export type ListMethod<M extends MethodDef> =
  & Method<M, [], AllParams<M>>
  & Paginated<M, AllParams<M>>;

/** Retrieve method - the id, if the path ends with a parameter */
export type RetrieveMethod<M extends MethodDef> = Method<
  M,
  IdArg<M>,
  ParentParams<M>
>;

/** Create method - requires body */
export type CreateMethod<M extends MethodDef> = M["body"] extends undefined
  ? Method<M, [], AllParams<M>>
  : Method<M, [body: M["body"]], AllParams<M>>;

/** Update method - the id, if the path ends with a parameter, and the body */
export type UpdateMethod<M extends MethodDef> = M["body"] extends undefined
  ? Method<M, IdArg<M>, ParentParams<M>>
  : Method<M, [...IdArg<M>, body: M["body"]], ParentParams<M>>;

/** Delete method - the id, if the path ends with a parameter */
export type DeleteMethod<M extends MethodDef> = Method<
  M,
  IdArg<M>,
  ParentParams<M>
>;

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
  /** Path template, e.g. `/api/tasks/{id}/events`. */
  readonly path?: string;
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
  /**
   * Values for the path parameters that are not the trailing id. Needs the
   * generated route table (`createClient({ routes })`).
   */
  readonly params?: Readonly<Record<string, string>>;
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

/** Options of a subscription, with the path parameters it has to supply. */
export type SubscribeOptionsFor<M> =
  & Omit<SubscribeOptions, "params">
  & ParamsOption<M, ParentParams<M>>;

/**
 * Subscribe method.
 *
 * With a path template: the id if the path ends with a parameter, and
 * `options.params` for the others. Without one (hand-written definitions):
 * an id if the definition has `params`.
 */
export type SubscribeMethod<M extends SseMethodDef> = [PathOf<M>] extends
  [never] ? M["params"] extends Record<string, string> ? (
      id: string,
      options?: SubscribeOptions,
    ) => AsyncIterable<TypedSseEvent<M["events"]>>
  : (options?: SubscribeOptions) => AsyncIterable<TypedSseEvent<M["events"]>>
  : (
    ...args: [
      ...IdArg<M>,
      ...([ParentParams<M>] extends [never] ? [options?: SubscribeOptionsFor<M>]
        : [options: SubscribeOptionsFor<M>]),
    ]
  ) => AsyncIterable<TypedSseEvent<M["events"]>>;

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
  & (R["replace"] extends MethodDef ? { replace: UpdateMethod<R["replace"]> }
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

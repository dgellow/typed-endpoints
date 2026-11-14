/**
 * Typed HTTP client for typed-endpoints.
 *
 * @example
 * ```typescript
 * import { createClient } from "@dgellow/typed-endpoints/client";
 * import type { Api } from "./api-types";
 *
 * const client = createClient<Api>("http://localhost:3000");
 *
 * // List all users
 * const users = await client.users.list();
 *
 * // Get a single user
 * const user = await client.users.retrieve("123");
 *
 * // Create a user
 * const created = await client.users.create({ name: "Sam", email: "sam@example.com" });
 *
 * // Delete a user
 * await client.users.delete("123");
 *
 * // Nested resources
 * const posts = await client.users.posts.list();
 * ```
 */

import type {
  ApiSchema,
  RequestOptions,
  SseEventsDef,
  SubscribeOptions,
  TypedClient,
  TypedSseEvent,
} from "./types.ts";
import { createSseParser } from "./sse.ts";

export type {
  AllOf,
  Apply,
  CertainNames,
  Dependent,
  Expansion,
  Flatten,
  IsUnion,
  PossibleNames,
  Projection,
  QueryList,
  ReadonlyDeep,
  Requires,
  RequiresIn,
  Resolve,
  ResolveIn,
  ResponseFamily,
} from "../core/dependent_types.ts";

export type {
  ChildrenOf,
  ParseItem,
  ParseItems,
  ParseSelect,
  PartialDeep,
  QueryText,
  SelectableIn,
  SelectDelimiter,
  Selected,
  SelectedBy,
  SelectError,
  Selection,
  SelectIssues,
  SelectNode,
  SelectProblem,
  SelectRequirement,
  TakeName,
  TrimSpaces,
} from "../core/selection_types.ts";

export type {
  AllParams,
  ApiSchema,
  CapturedOptionsArg,
  CreateMethod,
  DeleteMethod,
  Empty,
  IdArg,
  ListMethod,
  Method,
  MethodDef,
  MethodOptions,
  NeedsOptions,
  OptionsArg,
  ParamName,
  ParamsOption,
  ParentParams,
  PathOf,
  PathParamNames,
  RequestOptions,
  ResourceClient,
  ResourceDef,
  ResourceMethod,
  RetrieveMethod,
  SseEventsDef,
  SseMethodDef,
  SubscribeMethod,
  SubscribeOptions,
  SubscribeOptionsFor,
  TrailingParam,
  TypedClient,
  TypedSseEvent,
  UpdateMethod,
} from "./types.ts";

/** Configuration of `createClient()`. */
export interface ClientConfig {
  /** Base URL for all requests (e.g., "http://localhost:3000") */
  readonly baseUrl: string;
  /** Base path prefix (e.g., "/api"). Defaults to "/api" */
  readonly basePath?: string;
  /** Default headers to include in all requests */
  readonly headers?: Record<string, string>;
  /** Custom fetch implementation */
  readonly fetch?: typeof fetch;
  /**
   * The route table the type generator writes next to `Api`
   * (`export const routes` in the `client` format).
   *
   * With it, each call takes its HTTP method and its URL from the table:
   * routes with several path parameters, routes outside `basePath`, PUT
   * next to PATCH and catch-all paths all work. Without it, the client
   * derives the URL from the property names, which covers
   * `basePath/resource[/id]` only.
   */
  readonly routes?: ClientRoutes;
}

/** A generated route table: method and path template by client method. */
export type ClientRoutes = Readonly<
  Record<string, { readonly method: string; readonly path: string }>
>;

/** Methods that address one resource: their first argument can be its id. */
const ID_METHODS: ReadonlySet<string> = new Set([
  "retrieve",
  "update",
  "replace",
  "delete",
  "subscribe",
]);

/** Methods whose argument after the id, if any, is the request body. */
const BODY_METHODS: ReadonlySet<string> = new Set([
  "create",
  "update",
  "replace",
]);

/** Client methods; any other property is a nested resource. */
const CLIENT_METHODS: ReadonlySet<string> = new Set([
  "list",
  ...ID_METHODS,
  ...BODY_METHODS,
]);

/** Whether a path template ends with a parameter, e.g. `/users/{id}`. */
function endsWithParameter(template: string): boolean {
  return /\/\{\+?\w+\}$/.test(template);
}

/**
 * Fill a path template (`{name}`, and `{+name}` for a catch-all whose
 * value keeps its slashes, as in RFC 6570).
 *
 * The id fills the trailing parameter; `params` fill the others. A
 * parameter without a value is an error that names it.
 */
function fillTemplate(
  call: string,
  template: string,
  id: string | undefined,
  params: Readonly<Record<string, string>> = {},
): string {
  const trailing = id === undefined
    ? undefined
    : /\{\+?(\w+)\}$/.exec(template)?.[1];

  return template.replace(/\{(\+?)(\w+)\}/g, (_match, plus, name) => {
    const value = name === trailing ? id : params[name];
    if (value === undefined) {
      throw new TypeError(
        `${call}: no value for the path parameter "${name}" of ${template}; pass it in \`params\``,
      );
    }
    // A catch-all spans segments: encode each one, keep the slashes.
    return plus === "+"
      ? String(value).split("/").map(encodeURIComponent).join("/")
      : encodeURIComponent(String(value));
  });
}

/**
 * Build query string from object.
 */
function buildQuery(query?: Record<string, unknown>): string {
  if (!query) return "";

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) {
      if (Array.isArray(value)) {
        for (const v of value) {
          params.append(key, String(v));
        }
      } else {
        params.append(key, String(value));
      }
    }
  }

  const str = params.toString();
  return str ? `?${str}` : "";
}

/**
 * Raised when the data of an SSE event is not valid JSON.
 *
 * Thrown to the consumer of the subscription. It does not trigger a
 * reconnect: the server would send the same event again.
 */
export class SseDataError extends Error {
  /**
   * Create the error.
   *
   * @param event Type of the event.
   * @param data The `data` field as received.
   * @param options Standard error options, e.g. `cause`.
   */
  constructor(
    public readonly event: string,
    public readonly data: string,
    options?: ErrorOptions,
  ) {
    super(`SSE event "${event}" has data that is not valid JSON`, options);
    this.name = "SseDataError";
  }
}

/** Wait `ms` milliseconds. Resolves `false` early if the signal aborts. */
function delay(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Errors that asking again cannot fix. */
function isFatalSseError(error: unknown): boolean {
  if (error instanceof SseDataError) return true;
  return error instanceof ClientError && error.status >= 400 &&
    error.status < 500;
}

/**
 * Create SSE subscription as AsyncIterable.
 *
 * The iteration ends when the server closes the stream: an SSE endpoint
 * signals completion by returning from its handler. Network failures and 5xx
 * responses are retried; 4xx responses and undecodable events are not.
 */
async function* createSseSubscription<TEvents extends SseEventsDef>(
  fetchFn: typeof fetch,
  url: string,
  headers: Record<string, string>,
  options: SubscribeOptions = {},
): AsyncIterable<TypedSseEvent<TEvents>> {
  const { signal, reconnect = true, maxReconnectAttempts = 5 } = options;
  let reconnectDelay = options.reconnectDelay ?? 1000;

  let attempts = 0;
  let lastEventId: string | undefined;

  while (true) {
    try {
      const requestHeaders: Record<string, string> = {
        ...headers,
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
      };

      if (lastEventId) {
        requestHeaders["Last-Event-ID"] = lastEventId;
      }

      const response = await fetchFn(url, {
        headers: requestHeaders,
        signal,
      });

      if (!response.ok) {
        throw new ClientError(
          response.status,
          response.statusText,
          await response.text(),
        );
      }

      if (!response.body) {
        throw new Error("SSE response has no body");
      }

      attempts = 0; // Reset on successful connection
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = createSseParser();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const events = parser.push(decoder.decode(value, { stream: true }));
          if (parser.lastEventId !== undefined) {
            lastEventId = parser.lastEventId;
          }
          if (parser.retry !== undefined) {
            reconnectDelay = parser.retry;
          }

          for (const raw of events) {
            // An event with empty data carries no JSON value (some servers
            // use it as a keep-alive). It is skipped.
            if (raw.data === "") continue;

            let data: unknown;
            try {
              data = JSON.parse(raw.data);
            } catch (cause) {
              throw new SseDataError(raw.event, raw.data, { cause });
            }

            // `id` is a key only when the event has one.
            yield {
              event: raw.event,
              data,
              ...(raw.id !== undefined && { id: raw.id }),
            } as TypedSseEvent<TEvents>;
          }
        }
      } finally {
        // Runs when the stream ends, fails, or the consumer stops iterating.
        // Cancelling releases the connection in the last two cases.
        await reader.cancel().catch(() => {});
      }

      // Stream ended normally, exit
      return;
    } catch (error) {
      if (signal?.aborted) {
        return;
      }

      if (isFatalSseError(error)) {
        throw error;
      }

      attempts++;
      if (!reconnect || attempts >= maxReconnectAttempts) {
        throw error;
      }

      const waited = await delay(reconnectDelay * attempts, signal);
      if (!waited) return;
    }
  }
}

/**
 * HTTP client error with status and response body.
 */
export class ClientError extends Error {
  /**
   * Create the error.
   *
   * @param status HTTP status code.
   * @param statusText HTTP status text.
   * @param body Response body: parsed JSON when the response is JSON, text
   *   otherwise.
   */
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly body: unknown,
  ) {
    super(`HTTP ${status}: ${statusText}`);
    this.name = "ClientError";
  }
}

/**
 * Properties that must not resolve to a nested resource.
 *
 * - Symbols are looked up by the runtime (inspection, iteration, coercion).
 * - `then` is looked up by `await` and `Promise.resolve`: a resource that
 *   answers it with a function is treated as a thenable that never settles.
 * - `toJSON` is looked up by `JSON.stringify`.
 */
function isReservedProperty(prop: string | symbol): prop is symbol {
  return typeof prop === "symbol" || prop === "then" || prop === "toJSON";
}

/**
 * Create a typed HTTP client.
 */
export function createClient<Api extends ApiSchema>(
  config: string | ClientConfig,
): TypedClient<Api> {
  const cfg: ClientConfig = typeof config === "string"
    ? { baseUrl: config }
    : config;
  const basePath = cfg.basePath ?? "/api";
  const fetchFn = cfg.fetch ?? fetch;

  async function request(
    method: string,
    path: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<unknown> {
    const url = cfg.baseUrl + path + buildQuery(options?.query);

    const headers: Record<string, string> = {
      ...cfg.headers,
    };

    let bodyStr: string | undefined;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      bodyStr = JSON.stringify(body);
    }

    const response = await fetchFn(url, {
      method,
      headers,
      body: bodyStr,
      signal: options?.signal,
    });

    if (!response.ok) {
      // The body can be read once: take the text, then try it as JSON.
      const text = await response.text();
      let errorBody: unknown = text;
      try {
        errorBody = JSON.parse(text);
      } catch {
        // Not JSON: the text is the body.
      }
      throw new ClientError(response.status, response.statusText, errorBody);
    }

    // No content
    if (response.status === 204) {
      return undefined;
    }

    const contentType = response.headers.get("Content-Type") ?? "";
    if (contentType.includes("application/json")) {
      return response.json();
    }

    return response.text();
  }

  /**
   * Where a call goes: the HTTP method and the path, from the route table
   * when there is one, otherwise from the property names.
   */
  function resolveCall(
    pathSegments: string[],
    methodName: string,
    args: unknown[],
  ): {
    method: string;
    path: string;
    body: unknown;
    options: RequestOptions & SubscribeOptions;
  } {
    const call = [...pathSegments, methodName].join(".");
    const route = cfg.routes?.[call];
    if (cfg.routes && !route) {
      throw new TypeError(
        `${call}() is not in the route table passed to createClient()`,
      );
    }

    // With a route, the id is there exactly when the path ends with a
    // parameter. Without one, a resource method takes an id; a
    // subscription takes one if its first argument is a string.
    const rest = [...args];
    const takesId = !ID_METHODS.has(methodName)
      ? false
      : route
      ? endsWithParameter(route.path)
      : methodName !== "subscribe" || typeof rest[0] === "string";
    const id = takesId ? rest.shift() as string : undefined;
    const body = BODY_METHODS.has(methodName) ? rest.shift() : undefined;
    const options = (rest.shift() ?? {}) as RequestOptions & SubscribeOptions;

    if (route) {
      return {
        method: route.method,
        path: fillTemplate(call, route.path, id, options.params),
        body,
        options,
      };
    }

    if (options.params && Object.keys(options.params).length > 0) {
      throw new TypeError(
        `${call}(): \`params\` needs the generated route table; pass \`routes\` to createClient()`,
      );
    }
    const legacyMethods: Record<string, string> = {
      list: "GET",
      retrieve: "GET",
      create: "POST",
      update: "PUT",
      replace: "PUT",
      delete: "DELETE",
      subscribe: "GET",
    };
    return {
      method: legacyMethods[methodName],
      path: basePath + "/" + pathSegments.join("/") +
        (id === undefined ? "" : "/" + encodeURIComponent(id)),
      body,
      options,
    };
  }

  /**
   * Create a resource proxy that handles method calls and nested resources.
   */
  function createResourceProxy(pathSegments: string[]): unknown {
    return new Proxy(() => {}, {
      apply() {
        // Reached when a property that is not a client method is called,
        // e.g. a typo such as `client.users.lst()`.
        throw new TypeError(
          `"${pathSegments.at(-1)}" is not a client method (called as ${
            pathSegments.join(".")
          }())`,
        );
      },
      get(_target, prop: string | symbol) {
        if (isReservedProperty(prop)) return undefined;

        if (prop === "subscribe") {
          return (...args: unknown[]) => {
            const { path, options } = resolveCall(pathSegments, prop, args);
            const url = cfg.baseUrl + path + buildQuery(options.query);
            return createSseSubscription(
              fetchFn,
              url,
              cfg.headers ?? {},
              options,
            );
          };
        }

        if (CLIENT_METHODS.has(prop)) {
          return (...args: unknown[]) => {
            const { method, path, body, options } = resolveCall(
              pathSegments,
              prop,
              args,
            );
            return request(method, path, body, options);
          };
        }

        // Handle nested resources
        return createResourceProxy([...pathSegments, prop]);
      },
    });
  }

  // Create the root proxy
  return new Proxy({} as TypedClient<Api>, {
    get(_target, prop: string | symbol) {
      if (isReservedProperty(prop)) return undefined;
      return createResourceProxy([prop]);
    },
  });
}

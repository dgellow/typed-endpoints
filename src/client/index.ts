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
  ApiSchema,
  CreateMethod,
  DeleteMethod,
  Empty,
  ListMethod,
  MethodDef,
  MethodOptions,
  OptionsArg,
  RequestOptions,
  ResourceClient,
  ResourceDef,
  ResourceMethod,
  RetrieveMethod,
  SseEventsDef,
  SseMethodDef,
  SubscribeMethod,
  SubscribeOptions,
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

            yield {
              event: raw.event,
              data,
              id: raw.id,
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
      let errorBody: unknown;
      try {
        errorBody = await response.json();
      } catch {
        errorBody = await response.text();
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

        // Handle method calls
        if (prop === "list") {
          return (options?: RequestOptions) => {
            const path = basePath + "/" + pathSegments.join("/");
            return request("GET", path, undefined, options);
          };
        }

        if (prop === "retrieve") {
          return (id: string, options?: RequestOptions) => {
            const path = basePath + "/" + pathSegments.join("/") + "/" +
              encodeURIComponent(id);
            return request("GET", path, undefined, options);
          };
        }

        if (prop === "create") {
          return (body: unknown, options?: RequestOptions) => {
            const path = basePath + "/" + pathSegments.join("/");
            return request("POST", path, body, options);
          };
        }

        if (prop === "update") {
          return (id: string, body: unknown, options?: RequestOptions) => {
            const path = basePath + "/" + pathSegments.join("/") + "/" +
              encodeURIComponent(id);
            return request("PUT", path, body, options);
          };
        }

        if (prop === "delete") {
          return (id: string, options?: RequestOptions) => {
            const path = basePath + "/" + pathSegments.join("/") + "/" +
              encodeURIComponent(id);
            return request("DELETE", path, undefined, options);
          };
        }

        if (prop === "subscribe") {
          return (
            idOrOptions?: string | SubscribeOptions,
            maybeOptions?: SubscribeOptions,
          ) => {
            let path: string;
            let options: SubscribeOptions;

            if (typeof idOrOptions === "string") {
              path = basePath + "/" + pathSegments.join("/") + "/" +
                encodeURIComponent(idOrOptions);
              options = maybeOptions ?? {};
            } else {
              path = basePath + "/" + pathSegments.join("/");
              options = idOrOptions ?? {};
            }

            const url = cfg.baseUrl + path + buildQuery(options.query);
            return createSseSubscription(
              fetchFn,
              url,
              cfg.headers ?? {},
              options,
            );
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

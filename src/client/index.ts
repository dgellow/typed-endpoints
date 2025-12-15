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

export type {
  ApiSchema,
  MethodDef,
  RequestOptions,
  ResourceDef,
  ResourceMethod,
  SseEventsDef,
  SseMethodDef,
  SubscribeMethod,
  SubscribeOptions,
  TypedClient,
  TypedSseEvent,
} from "./types.ts";

export interface ClientConfig {
  /** Base URL for all requests (e.g., "http://localhost:3000") */
  baseUrl: string;
  /** Base path prefix (e.g., "/api"). Defaults to "/api" */
  basePath?: string;
  /** Default headers to include in all requests */
  headers?: Record<string, string>;
  /** Custom fetch implementation */
  fetch?: typeof fetch;
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
 * Parse SSE messages from raw text chunk.
 */
function parseSseMessages(
  chunk: string,
): Array<{ event?: string; data?: string; id?: string }> {
  const messages: Array<{ event?: string; data?: string; id?: string }> = [];
  const blocks = chunk.split("\n\n").filter(Boolean);

  for (const block of blocks) {
    const message: { event?: string; data?: string; id?: string } = {};
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) {
        message.event = line.slice(7);
      } else if (line.startsWith("data: ")) {
        message.data = line.slice(6);
      } else if (line.startsWith("id: ")) {
        message.id = line.slice(4);
      }
    }
    if (message.data !== undefined) {
      messages.push(message);
    }
  }
  return messages;
}

/**
 * Create SSE subscription as AsyncIterable.
 */
async function* createSseSubscription<TEvents extends SseEventsDef>(
  fetchFn: typeof fetch,
  url: string,
  headers: Record<string, string>,
  options: SubscribeOptions = {},
): AsyncIterable<TypedSseEvent<TEvents>> {
  const {
    signal,
    reconnect = true,
    reconnectDelay = 1000,
    maxReconnectAttempts = 5,
  } = options;

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
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const messages = parseSseMessages(buffer);

        // Keep incomplete messages in buffer
        const lastNewline = buffer.lastIndexOf("\n\n");
        if (lastNewline !== -1) {
          buffer = buffer.slice(lastNewline + 2);
        }

        for (const msg of messages) {
          if (msg.id) {
            lastEventId = msg.id;
          }

          if (msg.data) {
            yield {
              event: msg.event ?? "message",
              data: JSON.parse(msg.data),
              id: msg.id,
            } as TypedSseEvent<TEvents>;
          }
        }
      }

      // Stream ended normally, exit
      return;
    } catch (error) {
      if (signal?.aborted) {
        return;
      }

      attempts++;
      if (!reconnect || attempts >= maxReconnectAttempts) {
        throw error;
      }

      await new Promise((resolve) =>
        setTimeout(resolve, reconnectDelay * attempts)
      );
    }
  }
}

/**
 * HTTP client error with status and response body.
 */
export class ClientError extends Error {
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
      get(_target, prop: string) {
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
    get(_target, prop: string) {
      return createResourceProxy([prop]);
    },
  });
}

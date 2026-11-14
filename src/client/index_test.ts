import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { ClientError, createClient, SseDataError } from "./index.ts";

// Mock API type for testing (using type instead of interface for index signature compatibility)
type TestApi = {
  users: {
    list: { response: { id: string; name: string }[] };
    retrieve: { response: { id: string; name: string } };
    create: { body: { name: string }; response: { id: string; name: string } };
    delete: { response: void };
  };
  webhooks: {
    stripe: {
      create: {
        body: { type: string };
        response: { received: boolean };
      };
    };
  };
  tasks: {
    subscribe: {
      params: { id: string };
      events: {
        progress: { percent: number };
        complete: { result: string };
        error: { message: string };
      };
    };
  };
};

// Helper to create a mock fetch
function createMockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return handler as typeof fetch;
}

Deno.test("createClient.list makes GET request to resource path", async () => {
  const mockUsers = [{ id: "1", name: "Alice" }];
  const requests: { url: string; method: string }[] = [];

  const mockFetch = createMockFetch((url, init) => {
    requests.push({ url, method: init?.method ?? "GET" });
    return new Response(JSON.stringify(mockUsers), {
      headers: { "Content-Type": "application/json" },
    });
  });

  const client = createClient<TestApi>({
    baseUrl: "http://localhost:3000",
    fetch: mockFetch,
  });

  const result = await client.users.list();

  assertEquals(requests.length, 1);
  assertEquals(requests[0].url, "http://localhost:3000/api/users");
  assertEquals(requests[0].method, "GET");
  assertEquals(result, mockUsers);
});

Deno.test("createClient.retrieve makes GET request with id", async () => {
  const mockUser = { id: "123", name: "Bob" };
  const requests: { url: string; method: string }[] = [];

  const mockFetch = createMockFetch((url, init) => {
    requests.push({ url, method: init?.method ?? "GET" });
    return new Response(JSON.stringify(mockUser), {
      headers: { "Content-Type": "application/json" },
    });
  });

  const client = createClient<TestApi>({
    baseUrl: "http://localhost:3000",
    fetch: mockFetch,
  });

  const result = await client.users.retrieve("123");

  assertEquals(requests[0].url, "http://localhost:3000/api/users/123");
  assertEquals(requests[0].method, "GET");
  assertEquals(result, mockUser);
});

Deno.test("createClient.create makes POST request with body", async () => {
  const mockUser = { id: "456", name: "Charlie" };
  const requests: { url: string; method: string; body?: string }[] = [];

  const mockFetch = createMockFetch(async (url, init) => {
    const body = init?.body ? await new Response(init.body).text() : undefined;
    requests.push({ url, method: init?.method ?? "GET", body });
    return new Response(JSON.stringify(mockUser), {
      headers: { "Content-Type": "application/json" },
    });
  });

  const client = createClient<TestApi>({
    baseUrl: "http://localhost:3000",
    fetch: mockFetch,
  });

  const result = await client.users.create({ name: "Charlie" });

  assertEquals(requests[0].url, "http://localhost:3000/api/users");
  assertEquals(requests[0].method, "POST");
  assertEquals(requests[0].body, '{"name":"Charlie"}');
  assertEquals(result, mockUser);
});

Deno.test("createClient.delete makes DELETE request with id", async () => {
  const requests: { url: string; method: string }[] = [];

  const mockFetch = createMockFetch((url, init) => {
    requests.push({ url, method: init?.method ?? "GET" });
    return new Response(null, { status: 204 });
  });

  const client = createClient<TestApi>({
    baseUrl: "http://localhost:3000",
    fetch: mockFetch,
  });

  await client.users.delete("123");

  assertEquals(requests[0].url, "http://localhost:3000/api/users/123");
  assertEquals(requests[0].method, "DELETE");
});

Deno.test("createClient handles nested resources", async () => {
  const requests: { url: string; method: string }[] = [];

  const mockFetch = createMockFetch((url, init) => {
    requests.push({ url, method: init?.method ?? "GET" });
    return new Response(JSON.stringify({ received: true }), {
      headers: { "Content-Type": "application/json" },
    });
  });

  const client = createClient<TestApi>({
    baseUrl: "http://localhost:3000",
    fetch: mockFetch,
  });

  const result = await client.webhooks.stripe.create({ type: "payment" });

  assertEquals(requests[0].url, "http://localhost:3000/api/webhooks/stripe");
  assertEquals(requests[0].method, "POST");
  assertEquals(result, { received: true });
});

Deno.test("createClient resources are not thenables", async () => {
  const client = createClient<TestApi>({
    baseUrl: "http://localhost:3000",
    fetch: createMockFetch(() => Response.json([])),
  });

  // `await` looks up `then`. If the proxy answered with a nested resource,
  // these awaits would never settle and the test would time out.
  const users = await client.users;
  const stripe = await Promise.resolve(client.webhooks.stripe);

  assertEquals(await users.list(), []);
  assertEquals(typeof stripe.create, "function");
  // deno-lint-ignore no-explicit-any
  assertEquals((client as any).then, undefined);
  // deno-lint-ignore no-explicit-any
  assertEquals((client.users as any)[Symbol.toPrimitive], undefined);
});

Deno.test("createClient throws when an unknown method is called", () => {
  const client = createClient<TestApi>({
    baseUrl: "http://localhost:3000",
    fetch: createMockFetch(() => Response.json([])),
  });

  assertThrows(
    // deno-lint-ignore no-explicit-any
    () => (client.users as any).lst(),
    TypeError,
    '"lst" is not a client method (called as users.lst())',
  );
});

Deno.test("createClient throws ClientError on non-ok response", async () => {
  const mockFetch = createMockFetch(() => {
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      statusText: "Not Found",
      headers: { "Content-Type": "application/json" },
    });
  });

  const client = createClient<TestApi>({
    baseUrl: "http://localhost:3000",
    fetch: mockFetch,
  });

  const error = await assertRejects(
    () => client.users.retrieve("999"),
    ClientError,
  );

  assertEquals(error.status, 404);
  assertEquals(error.body, { error: "Not found" });
});

Deno.test("createClient uses custom basePath", async () => {
  const requests: { url: string }[] = [];

  const mockFetch = createMockFetch((url) => {
    requests.push({ url });
    return new Response(JSON.stringify([]), {
      headers: { "Content-Type": "application/json" },
    });
  });

  const client = createClient<TestApi>({
    baseUrl: "http://localhost:3000",
    basePath: "/v1",
    fetch: mockFetch,
  });

  await client.users.list();

  assertEquals(requests[0].url, "http://localhost:3000/v1/users");
});

Deno.test("createClient passes query params", async () => {
  const requests: { url: string }[] = [];

  const mockFetch = createMockFetch((url) => {
    requests.push({ url });
    return new Response(JSON.stringify([]), {
      headers: { "Content-Type": "application/json" },
    });
  });

  const client = createClient<TestApi>({
    baseUrl: "http://localhost:3000",
    fetch: mockFetch,
  });

  await client.users.list({ query: { limit: 10, offset: 20 } });

  assertEquals(
    requests[0].url,
    "http://localhost:3000/api/users?limit=10&offset=20",
  );
});

Deno.test("createClient with string config uses it as baseUrl", async () => {
  const requests: { url: string }[] = [];

  const mockFetch = createMockFetch((url) => {
    requests.push({ url });
    return new Response(JSON.stringify([]), {
      headers: { "Content-Type": "application/json" },
    });
  });

  // Note: We can't override fetch when using string config in production,
  // but we can test the URL construction by using a full config object
  const client = createClient<TestApi>({
    baseUrl: "https://api.example.com",
    fetch: mockFetch,
  });

  await client.users.list();

  assertEquals(requests[0].url, "https://api.example.com/api/users");
});

Deno.test("createClient.subscribe creates SSE connection", async () => {
  const requests: { url: string; headers: Record<string, string> }[] = [];

  // Create a mock SSE response
  const sseData = [
    'event: progress\ndata: {"percent":50}\n\n',
    'event: complete\ndata: {"result":"done"}\n\n',
  ].join("");

  const mockFetch = createMockFetch((url, init) => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers)) {
        headers[k] = v as string;
      }
    }
    requests.push({ url, headers });

    return new Response(sseData, {
      headers: { "Content-Type": "text/event-stream" },
    });
  });

  const client = createClient<TestApi>({
    baseUrl: "http://localhost:3000",
    fetch: mockFetch,
  });

  const events: Array<{ event: string; data: unknown }> = [];
  for await (const event of client.tasks.subscribe("task-123")) {
    events.push({ event: event.event as string, data: event.data });
  }

  assertEquals(requests[0].url, "http://localhost:3000/api/tasks/task-123");
  assertEquals(requests[0].headers["Accept"], "text/event-stream");
  assertEquals(events.length, 2);
  assertEquals(events[0], { event: "progress", data: { percent: 50 } });
  assertEquals(events[1], { event: "complete", data: { result: "done" } });
});

Deno.test("createClient.subscribe without id", async () => {
  const requests: { url: string }[] = [];

  const sseData = 'event: update\ndata: {"count":1}\n\n';

  const mockFetch = createMockFetch((url) => {
    requests.push({ url });
    return new Response(sseData, {
      headers: { "Content-Type": "text/event-stream" },
    });
  });

  // Test API without params requirement
  type NoParamsSseApi = {
    metrics: {
      subscribe: {
        events: { update: { count: number } };
      };
    };
  };

  const client = createClient<NoParamsSseApi>({
    baseUrl: "http://localhost:3000",
    fetch: mockFetch,
  });

  const events: Array<{ event: string; data: unknown }> = [];
  for await (const event of client.metrics.subscribe()) {
    events.push({ event: event.event as string, data: event.data });
  }

  assertEquals(requests[0].url, "http://localhost:3000/api/metrics");
  assertEquals(events.length, 1);
  assertEquals(events[0], { event: "update", data: { count: 1 } });
});

Deno.test("createClient.subscribe parses event IDs", async () => {
  const sseData = 'id: msg-001\nevent: update\ndata: {"value":1}\n\n';

  const mockFetch = createMockFetch(() => {
    return new Response(sseData, {
      headers: { "Content-Type": "text/event-stream" },
    });
  });

  type TestApi = {
    stream: {
      subscribe: { events: { update: { value: number } } };
    };
  };

  const client = createClient<TestApi>({
    baseUrl: "http://localhost:3000",
    fetch: mockFetch,
  });

  const events: Array<{ event: string; data: unknown; id?: string }> = [];
  for await (const event of client.stream.subscribe()) {
    events.push({
      event: event.event as string,
      data: event.data,
      id: event.id,
    });
  }

  assertEquals(events[0].id, "msg-001");
  assertEquals(events[0].data, { value: 1 });
});

Deno.test("createClient.subscribe handles default event type", async () => {
  // When no event: field, should default to "message"
  const sseData = 'data: {"test":true}\n\n';

  const mockFetch = createMockFetch(() => {
    return new Response(sseData, {
      headers: { "Content-Type": "text/event-stream" },
    });
  });

  type TestApi = {
    stream: {
      subscribe: { events: { message: { test: boolean } } };
    };
  };

  const client = createClient<TestApi>({
    baseUrl: "http://localhost:3000",
    fetch: mockFetch,
  });

  const events: Array<{ event: string; data: unknown }> = [];
  for await (const event of client.stream.subscribe()) {
    events.push({ event: event.event as string, data: event.data });
  }

  assertEquals(events[0].event, "message");
  assertEquals(events[0].data, { test: true });
});

Deno.test("createClient.subscribe handles multiple events in one chunk", async () => {
  const sseData = [
    'event: a\ndata: {"n":1}\n\n',
    'event: b\ndata: {"n":2}\n\n',
    'event: c\ndata: {"n":3}\n\n',
  ].join("");

  const mockFetch = createMockFetch(() => {
    return new Response(sseData, {
      headers: { "Content-Type": "text/event-stream" },
    });
  });

  type TestApi = {
    stream: {
      subscribe: {
        events: { a: { n: number }; b: { n: number }; c: { n: number } };
      };
    };
  };

  const client = createClient<TestApi>({
    baseUrl: "http://localhost:3000",
    fetch: mockFetch,
  });

  const events: Array<{ event: string; data: unknown }> = [];
  for await (const event of client.stream.subscribe()) {
    events.push({ event: event.event as string, data: event.data });
  }

  assertEquals(events.length, 3);
  assertEquals(events[0], { event: "a", data: { n: 1 } });
  assertEquals(events[1], { event: "b", data: { n: 2 } });
  assertEquals(events[2], { event: "c", data: { n: 3 } });
});

Deno.test("createClient.subscribe throws on non-ok response", async () => {
  const mockFetch = createMockFetch(() => {
    return new Response("Not found", { status: 404, statusText: "Not Found" });
  });

  type TestApi = {
    stream: {
      subscribe: { events: { update: { value: number } } };
    };
  };

  const client = createClient<TestApi>({
    baseUrl: "http://localhost:3000",
    fetch: mockFetch,
  });

  const error = await assertRejects(async () => {
    for await (const _ of client.stream.subscribe({ reconnect: false })) {
      // Should not reach here
    }
  }, ClientError);

  assertEquals(error.status, 404);
});

Deno.test("createClient.subscribe respects abort signal", async () => {
  const controller = new AbortController();
  let fetchCount = 0;

  const mockFetch = createMockFetch(() => {
    fetchCount++;
    // Return a stream that would keep going, but we'll abort
    return new Response('event: ping\ndata: {"n":1}\n\n', {
      headers: { "Content-Type": "text/event-stream" },
    });
  });

  type TestApi = {
    stream: {
      subscribe: { events: { ping: { n: number } } };
    };
  };

  const client = createClient<TestApi>({
    baseUrl: "http://localhost:3000",
    fetch: mockFetch,
  });

  const events: unknown[] = [];
  for await (
    const event of client.stream.subscribe({
      signal: controller.signal,
    })
  ) {
    events.push(event);
    controller.abort(); // Abort after first event
  }

  assertEquals(events.length, 1);
  assertEquals(fetchCount, 1);
});

Deno.test("createClient.subscribe passes query params", async () => {
  const requests: { url: string }[] = [];

  const mockFetch = createMockFetch((url) => {
    requests.push({ url });
    return new Response('data: {"ok":true}\n\n', {
      headers: { "Content-Type": "text/event-stream" },
    });
  });

  type TestApi = {
    stream: {
      subscribe: { events: { message: { ok: boolean } } };
    };
  };

  const client = createClient<TestApi>({
    baseUrl: "http://localhost:3000",
    fetch: mockFetch,
  });

  for await (
    const _ of client.stream.subscribe({
      query: { filter: "active", limit: 10 },
    })
  ) {
    // consume
  }

  assertEquals(
    requests[0].url,
    "http://localhost:3000/api/stream?filter=active&limit=10",
  );
});

// =============================================================================
// SSE failure handling
// =============================================================================

type StreamApi = {
  stream: {
    subscribe: { events: { update: { value: number } } };
  };
};

function sseResponse(body: string | ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

Deno.test("createClient.subscribe does not retry a 4xx response", async () => {
  let fetchCount = 0;
  const client = createClient<StreamApi>({
    baseUrl: "http://localhost:3000",
    fetch: createMockFetch(() => {
      fetchCount++;
      return new Response("nope", { status: 403, statusText: "Forbidden" });
    }),
  });

  const error = await assertRejects(async () => {
    for await (const _ of client.stream.subscribe({ reconnectDelay: 1 })) {
      // not reached
    }
  }, ClientError);

  assertEquals(error.status, 403);
  assertEquals(fetchCount, 1);
});

Deno.test("createClient.subscribe retries a 5xx response and resumes", async () => {
  const lastEventIds: (string | undefined)[] = [];
  let fetchCount = 0;
  const client = createClient<StreamApi>({
    baseUrl: "http://localhost:3000",
    fetch: createMockFetch((_url, init) => {
      fetchCount++;
      lastEventIds.push(
        (init?.headers as Record<string, string>)["Last-Event-ID"],
      );
      if (fetchCount === 1) {
        // Delivers one event, then the connection breaks.
        let pulls = 0;
        return sseResponse(
          new ReadableStream({
            pull(controller) {
              if (pulls++ === 0) {
                controller.enqueue(
                  new TextEncoder().encode(
                    'event: update\nid: 1\ndata: {"value":1}\n\n',
                  ),
                );
              } else {
                controller.error(new Error("connection reset"));
              }
            },
          }),
        );
      }
      if (fetchCount === 2) {
        return new Response("down", { status: 503 });
      }
      return sseResponse('event: update\nid: 2\ndata: {"value":2}\n\n');
    }),
  });

  const values: number[] = [];
  for await (const e of client.stream.subscribe({ reconnectDelay: 1 })) {
    values.push(e.data.value);
  }

  assertEquals(values, [1, 2]);
  assertEquals(fetchCount, 3);
  assertEquals(lastEventIds, [undefined, "1", "1"]);
});

Deno.test("createClient.subscribe reports undecodable data without reconnecting", async () => {
  let fetchCount = 0;
  const client = createClient<StreamApi>({
    baseUrl: "http://localhost:3000",
    fetch: createMockFetch(() => {
      fetchCount++;
      return sseResponse(
        'event: update\ndata: {"value":1}\n\nevent: update\ndata: not json\n\n',
      );
    }),
  });

  const values: number[] = [];
  const error = await assertRejects(async () => {
    for await (const e of client.stream.subscribe({ reconnectDelay: 1 })) {
      values.push(e.data.value);
    }
  }, SseDataError);

  assertEquals(values, [1]);
  assertEquals(error.event, "update");
  assertEquals(error.data, "not json");
  assertEquals(fetchCount, 1);
});

Deno.test("createClient.subscribe closes the connection when the consumer stops", async () => {
  let cancelled = false;
  const client = createClient<StreamApi>({
    baseUrl: "http://localhost:3000",
    fetch: createMockFetch(() =>
      sseResponse(
        new ReadableStream({
          start(controller) {
            // An open stream: one event, never closed by the server.
            controller.enqueue(
              new TextEncoder().encode('event: update\ndata: {"value":1}\n\n'),
            );
          },
          cancel() {
            cancelled = true;
          },
        }),
      )
    ),
  });

  for await (const e of client.stream.subscribe()) {
    assertEquals(e.data.value, 1);
    break;
  }

  assertEquals(cancelled, true);
});

Deno.test("createClient.subscribe stops waiting to reconnect when aborted", async () => {
  const controller = new AbortController();
  let fetchCount = 0;
  const client = createClient<StreamApi>({
    baseUrl: "http://localhost:3000",
    fetch: createMockFetch(() => {
      fetchCount++;
      queueMicrotask(() => controller.abort());
      return new Response("down", { status: 500 });
    }),
  });

  const started = Date.now();
  for await (
    const _ of client.stream.subscribe({
      signal: controller.signal,
      reconnectDelay: 60_000,
    })
  ) {
    // not reached
  }

  assertEquals(fetchCount, 1);
  assertEquals(Date.now() - started < 5_000, true);
});

Deno.test("createClient.subscribe joins multi-line data and accepts CRLF", async () => {
  type TextApi = { log: { subscribe: { events: { line: string[] } } } };
  const client = createClient<TextApi>({
    baseUrl: "http://localhost:3000",
    fetch: createMockFetch(() =>
      sseResponse(': hello\r\nevent:line\r\ndata:["a",\r\ndata:"b"]\r\n\r\n')
    ),
  });

  const events = [];
  for await (const e of client.log.subscribe()) events.push(e);

  // No `id` key: the event has no id field.
  assertEquals(events, [{ event: "line", data: ["a", "b"] }]);
});

// =============================================================================
// Typed query
// =============================================================================

Deno.test("createClient types the query from the Api definition", async () => {
  type QueryApi = {
    users: {
      // every key optional: the options argument stays optional
      list: {
        query: { limit?: number | undefined; cursor?: string | undefined };
        response: string[];
      };
      // a required key: the options argument is required
      retrieve: {
        query: { expand: "posts" | "none" };
        response: { id: string };
      };
    };
  };

  const urls: string[] = [];
  const client = createClient<QueryApi>({
    baseUrl: "http://localhost:3000",
    fetch: createMockFetch((url) => {
      urls.push(url);
      return Response.json([]);
    }),
  });

  await client.users.list();
  await client.users.list({ query: { limit: 5 } });
  await client.users.retrieve("1", { query: { expand: "posts" } });

  // @ts-expect-error unknown query key
  await client.users.list({ query: { nope: 1 } });
  // @ts-expect-error wrong value type
  await client.users.list({ query: { limit: "5" } });
  // @ts-expect-error the query has a required key
  await client.users.retrieve("1");
  // @ts-expect-error value outside the union
  await client.users.retrieve("1", { query: { expand: "all" } });

  assertEquals(urls.slice(0, 3), [
    "http://localhost:3000/api/users",
    "http://localhost:3000/api/users?limit=5",
    "http://localhost:3000/api/users/1?expand=posts",
  ]);
});

// =============================================================================
// Request and response edge cases
// =============================================================================

Deno.test("createClient reports a non-JSON error body as text", async () => {
  const client = createClient<TestApi>({
    baseUrl: "http://localhost:3000",
    fetch: createMockFetch(() =>
      new Response("<html>Bad Gateway</html>", {
        status: 502,
        statusText: "Bad Gateway",
        headers: { "Content-Type": "text/html" },
      })
    ),
  });

  const error = await assertRejects(() => client.users.list(), ClientError);
  assertEquals(error.status, 502);
  assertEquals(error.statusText, "Bad Gateway");
  assertEquals(error.body, "<html>Bad Gateway</html>");
});

Deno.test("createClient reports an empty error body as an empty string", async () => {
  const client = createClient<TestApi>({
    baseUrl: "http://localhost:3000",
    fetch: createMockFetch(() => new Response(null, { status: 404 })),
  });

  const error = await assertRejects(() => client.users.list(), ClientError);
  assertEquals(error.status, 404);
  assertEquals(error.body, "");
});

Deno.test("createClient returns a non-JSON success body as text", async () => {
  const client = createClient<TestApi>({
    baseUrl: "http://localhost:3000",
    fetch: createMockFetch(() =>
      new Response("pong", { headers: { "Content-Type": "text/plain" } })
    ),
  });

  assertEquals(await client.users.list() as unknown, "pong");
});

Deno.test("createClient returns undefined for 204", async () => {
  const client = createClient<TestApi>({
    baseUrl: "http://localhost:3000",
    fetch: createMockFetch(() => new Response(null, { status: 204 })),
  });

  assertEquals(await client.users.delete("1"), undefined);
});

Deno.test("createClient repeats the key for an array query value and skips null", async () => {
  const urls: string[] = [];
  const client = createClient<TestApi>({
    baseUrl: "http://localhost:3000",
    fetch: createMockFetch((url) => {
      urls.push(url);
      return Response.json([]);
    }),
  });

  await client.users.list({
    query: { tag: ["a", "b c"], page: 2, empty: null, missing: undefined },
  });

  assertEquals(urls, ["http://localhost:3000/api/users?tag=a&tag=b+c&page=2"]);
});

Deno.test("createClient.update sends PUT with id and body", async () => {
  type Api = {
    users: {
      update: { body: { name: string }; response: { id: string } };
    };
  };
  const requests: { url: string; method?: string; body?: string }[] = [];
  const client = createClient<Api>({
    baseUrl: "http://localhost:3000",
    fetch: createMockFetch((url, init) => {
      requests.push({ url, method: init?.method, body: init?.body as string });
      return Response.json({ id: "a/b" });
    }),
  });

  const result = await client.users.update("a/b", { name: "Ada" });

  assertEquals(result, { id: "a/b" });
  assertEquals(requests, [{
    url: "http://localhost:3000/api/users/a%2Fb",
    method: "PUT",
    body: '{"name":"Ada"}',
  }]);
});

Deno.test("createClient sends default headers and Content-Type only with a body", async () => {
  const seen: Record<string, string>[] = [];
  const client = createClient<TestApi>({
    baseUrl: "http://localhost:3000",
    headers: { Authorization: "Bearer t" },
    fetch: createMockFetch((_url, init) => {
      seen.push({ ...(init?.headers as Record<string, string>) });
      return Response.json({});
    }),
  });

  await client.users.list();
  await client.users.create({ name: "Ada" });

  assertEquals(seen[0], { Authorization: "Bearer t" });
  assertEquals(seen[1], {
    Authorization: "Bearer t",
    "Content-Type": "application/json",
  });
});

// =============================================================================
// Paging: list.pages() and list.items()
// =============================================================================

type PagedApi = {
  things: {
    list: {
      path: "/things";
      query: Record<string, unknown>;
      response: { items: { id: string }[]; [key: string]: unknown };
      pagination: { style: string; items: "items" };
    };
  };
};

/** A client whose `things.list` has the given pagination, over a mock. */
function pagedClient(
  pagination: Record<string, string>,
  respond: (url: URL) => unknown,
) {
  const urls: string[] = [];
  const client = createClient<PagedApi>({
    baseUrl: "https://api.example.com",
    routes: {
      "things.list": {
        method: "GET",
        path: "/things",
        pagination: { items: "items", ...pagination } as never,
      },
    },
    fetch: createMockFetch((url) => {
      urls.push(String(url).replace("https://api.example.com", ""));
      return Response.json(respond(new URL(String(url))));
    }),
  });
  return { client, urls };
}

async function collectAll<T>(source: AsyncIterable<T>): Promise<T[]> {
  const all: T[] = [];
  for await (const value of source) all.push(value);
  return all;
}

const ids = (...names: string[]) => names.map((id) => ({ id }));

Deno.test("paging: a server that returns the cursor it was given is not asked again", async () => {
  const { client, urls } = pagedClient(
    { style: "cursor", cursor: "next", cursorParam: "cursor" },
    () => ({ items: ids("a"), next: "same" }),
  );
  await assertRejects(
    () => collectAll(client.things.list.pages()),
    Error,
    "things.list: the server answered with the cursor it was asked for",
  );
  // The first page, and the page for the cursor: no third request.
  assertEquals(urls, ["/things", "/things?cursor=same"]);
});

Deno.test("paging: an empty cursor ends the pages", async () => {
  for (const last of [undefined, null, ""]) {
    const { client, urls } = pagedClient(
      { style: "cursor", cursor: "next", cursorParam: "cursor" },
      (url) =>
        url.searchParams.has("cursor")
          ? { items: ids("b"), next: last }
          : { items: ids("a"), next: "2" },
    );
    assertEquals(
      await collectAll(client.things.list.items()),
      ids("a", "b"),
    );
    assertEquals(urls, ["/things", "/things?cursor=2"]);
  }
});

Deno.test("paging: page numbers stop at a short page when there is no total", async () => {
  const all = ids("a", "b", "c", "d", "e");
  const { client, urls } = pagedClient(
    { style: "page", pageParam: "page", perPageParam: "size" },
    (url) => {
      const page = Number(url.searchParams.get("page") ?? 1);
      return { items: all.slice((page - 1) * 2, page * 2) };
    },
  );
  assertEquals(await collectAll(client.things.list.items()), all);
  // The size of the first page is the page size: the third page is short.
  assertEquals(urls, ["/things", "/things?page=2", "/things?page=3"]);
});

Deno.test("paging: page numbers stop at the total", async () => {
  const all = ids("a", "b", "c", "d");
  const { client, urls } = pagedClient(
    { style: "page", pageParam: "page", perPageParam: "size", total: "total" },
    (url) => {
      const page = Number(url.searchParams.get("page") ?? 1);
      return { items: all.slice((page - 1) * 2, page * 2), total: 4 };
    },
  );
  assertEquals(await collectAll(client.things.list.items()), all);
  // Two full pages make the total: no request for an empty third page.
  assertEquals(urls, ["/things", "/things?page=2"]);
});

Deno.test("paging: cursor-id needs an id on the last item", async () => {
  const { client } = pagedClient(
    { style: "cursorId", cursorIdParam: "after", idField: "uid" },
    () => ({ items: ids("a") }),
  );
  await assertRejects(
    () => collectAll(client.things.list.items()),
    Error,
    'the last item of the page has no "uid" to continue from',
  );
});

Deno.test("paging: a next URL is followed on the origin of baseUrl only", async () => {
  // Absolute, same origin: followed.
  const same = pagedClient(
    { style: "url", nextUrl: "next" },
    (url) =>
      url.searchParams.has("p")
        ? { items: ids("b") }
        : { items: ids("a"), next: "https://api.example.com/things?p=2" },
  );
  assertEquals(
    await collectAll(same.client.things.list.items()),
    ids("a", "b"),
  );
  assertEquals(same.urls, ["/things", "/things?p=2"]);

  // Another origin: the request would carry this client's headers there.
  const other = pagedClient(
    { style: "url", nextUrl: "next" },
    () => ({ items: ids("a"), next: "https://elsewhere.example/things?p=2" }),
  );
  await assertRejects(
    () => collectAll(other.client.things.list.items()),
    Error,
    "the next page is at https://elsewhere.example, which is not the origin of baseUrl",
  );
  assertEquals(other.urls, ["/things"]);

  // A URL that points at itself.
  const loop = pagedClient(
    { style: "url", nextUrl: "next" },
    () => ({ items: ids("a"), next: "/things?p=2" }),
  );
  await assertRejects(
    () => collectAll(loop.client.things.list.items()),
    Error,
    "the server answered with the URL it was asked for",
  );
  assertEquals(loop.urls, ["/things", "/things?p=2"]);
});

Deno.test("paging: metadata that lacks what its style needs is reported", async () => {
  const { client } = pagedClient(
    { style: "cursor" },
    () => ({ items: ids("a") }),
  );
  await assertRejects(
    () => collectAll(client.things.list.pages()),
    TypeError,
    'the pagination metadata has no cursorParam for style "cursor"',
  );

  const unknown = pagedClient({ style: "spiral" }, () => ({ items: [] }));
  await assertRejects(
    () => collectAll(unknown.client.things.list.pages()),
    TypeError,
    'unknown pagination style "spiral"',
  );
});

Deno.test("paging: the options of the call go with every page", async () => {
  const controller = new AbortController();
  const signals: (AbortSignal | null | undefined)[] = [];
  const client = createClient<PagedApi>({
    baseUrl: "https://api.example.com",
    routes: {
      "things.list": {
        method: "GET",
        path: "/things",
        pagination: {
          style: "offset",
          items: "items",
          offsetParam: "offset",
          total: "total",
        },
      },
    },
    fetch: createMockFetch((url, init) => {
      signals.push(init?.signal);
      const offset = Number(new URL(String(url)).searchParams.get("offset"));
      return Response.json({ items: ids(`i${offset}`), total: 3 });
    }),
  });

  const urls: string[] = [];
  for await (
    const page of client.things.list.pages({
      query: { tag: "x" },
      signal: controller.signal,
    })
  ) {
    urls.push(String(page.items[0].id));
  }
  assertEquals(urls, ["i0", "i1", "i2"]);
  assertEquals(signals, [
    controller.signal,
    controller.signal,
    controller.signal,
  ]);
});

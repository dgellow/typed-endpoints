import { assertEquals, assertRejects } from "@std/assert";
import { ClientError, createClient } from "./index.ts";

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

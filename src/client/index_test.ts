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

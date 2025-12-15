/**
 * End-to-end Fresh 2 test
 *
 * This test spawns an actual HTTP server and tests the full request/response cycle
 * including validation, pagination, and SSE.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  createApiHandlers,
  endpoint,
  sseEndpoint,
} from "../src/adapters/fresh.ts";
import { z } from "zod";
import { cursor } from "../src/pagination/index.ts";

const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
});

// In-memory data store for tests
const users = [
  { id: "1", name: "Alice", email: "alice@example.com" },
  { id: "2", name: "Bob", email: "bob@example.com" },
  { id: "3", name: "Charlie", email: "charlie@example.com" },
];

// Create handlers for our test API
const usersHandlers = createApiHandlers({
  // List users with cursor pagination
  GET: endpoint({
    ...cursor.paginated({
      item: UserSchema,
      names: { items: "data", cursor: "nextCursor" },
      defaultLimit: 2,
      maxLimit: 10,
      extraQuery: {
        search: z.string().optional(),
      },
    }),
    handler: (_ctx, { query }) => {
      let filteredUsers = users;
      if (query.search) {
        filteredUsers = users.filter((u) =>
          u.name.toLowerCase().includes(query.search!.toLowerCase())
        );
      }

      const startIndex = query.cursor
        ? filteredUsers.findIndex((u) => u.id === query.cursor) + 1
        : 0;
      const items = filteredUsers.slice(startIndex, startIndex + query.limit);
      const nextCursor = items.length === query.limit
        ? items[items.length - 1]?.id
        : undefined;

      return Response.json({ data: items, nextCursor });
    },
  }),

  // Create user
  POST: endpoint({
    body: z.object({
      name: z.string().min(1),
      email: z.string().email(),
    }),
    response: UserSchema,
    handler: (_ctx, { body }) => {
      const newUser = {
        id: String(users.length + 1),
        name: body.name,
        email: body.email,
      };
      return Response.json(newUser, { status: 201 });
    },
  }),
});

const userHandlers = createApiHandlers({
  // Get single user
  GET: endpoint({
    params: z.object({ id: z.string() }),
    response: UserSchema,
    handler: (_ctx, { params }) => {
      const user = users.find((u) => u.id === params.id);
      if (!user) {
        return new Response(JSON.stringify({ error: "User not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      return Response.json(user);
    },
  }),
});

const eventsHandlers = createApiHandlers({
  // SSE endpoint
  GET: sseEndpoint({
    events: {
      message: z.object({ text: z.string() }),
      done: z.object({ count: z.number() }),
    },
    async *handler(_ctx, _validated, signal) {
      for (let i = 1; i <= 3; i++) {
        if (signal.aborted) return;
        yield { event: "message", data: { text: `Message ${i}` } };
        await new Promise((r) => setTimeout(r, 10));
      }
      yield { event: "done", data: { count: 3 } };
    },
  }),
});

// Simple router for testing
// deno-lint-ignore no-explicit-any
function createRouter(routes: Record<string, any>) {
  // deno-lint-ignore no-explicit-any
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const method = req.method;

    // Match /api/users/:id
    const userMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
    if (userMatch) {
      const handler = routes["/api/users/:id"]?.[method];
      if (handler) {
        return handler({
          req,
          params: { id: userMatch[1] },
        });
      }
    }

    // Match /api/users
    if (url.pathname === "/api/users") {
      const handler = routes["/api/users"]?.[method];
      if (handler) {
        return handler({ req, params: {} });
      }
    }

    // Match /api/events
    if (url.pathname === "/api/events") {
      const handler = routes["/api/events"]?.[method];
      if (handler) {
        return handler({ req, params: {} });
      }
    }

    return new Response("Not Found", { status: 404 });
  };
}

const router = createRouter({
  "/api/users": usersHandlers,
  "/api/users/:id": userHandlers,
  "/api/events": eventsHandlers,
});

// Start a test server
function startTestServer(): {
  port: number;
  close: () => void;
} {
  const controller = new AbortController();
  const port = 8765 + Math.floor(Math.random() * 1000);

  Deno.serve(
    {
      port,
      signal: controller.signal,
      onListen: () => {},
    },
    router,
  );

  return {
    port,
    close: () => controller.abort(),
  };
}

// =============================================================================
// End-to-end tests
// =============================================================================

Deno.test("E2E: GET /api/users returns paginated list", async () => {
  const server = startTestServer();
  try {
    const response = await fetch(`http://localhost:${server.port}/api/users`);

    assertEquals(response.status, 200);
    const data = await response.json();

    assertEquals(data.data.length, 2); // default limit is 2
    assertEquals(data.data[0].name, "Alice");
    assertEquals(data.data[1].name, "Bob");
    assertEquals(data.nextCursor, "2"); // Bob's ID
  } finally {
    server.close();
  }
});

Deno.test("E2E: GET /api/users with cursor pagination", async () => {
  const server = startTestServer();
  try {
    // First page
    const response1 = await fetch(`http://localhost:${server.port}/api/users`);
    const data1 = await response1.json();
    assertEquals(data1.data.length, 2);
    assertEquals(data1.nextCursor, "2");

    // Second page using cursor
    const response2 = await fetch(
      `http://localhost:${server.port}/api/users?cursor=2`,
    );
    const data2 = await response2.json();
    assertEquals(data2.data.length, 1);
    assertEquals(data2.data[0].name, "Charlie");
    assertEquals(data2.nextCursor, undefined);
  } finally {
    server.close();
  }
});

Deno.test("E2E: GET /api/users with custom limit", async () => {
  const server = startTestServer();
  try {
    const response = await fetch(
      `http://localhost:${server.port}/api/users?limit=1`,
    );
    const data = await response.json();

    assertEquals(data.data.length, 1);
    assertEquals(data.data[0].name, "Alice");
  } finally {
    server.close();
  }
});

Deno.test("E2E: GET /api/users with search filter", async () => {
  const server = startTestServer();
  try {
    const response = await fetch(
      `http://localhost:${server.port}/api/users?search=bob`,
    );
    const data = await response.json();

    assertEquals(data.data.length, 1);
    assertEquals(data.data[0].name, "Bob");
  } finally {
    server.close();
  }
});

Deno.test("E2E: GET /api/users with invalid limit returns 400", async () => {
  const server = startTestServer();
  try {
    const response = await fetch(
      `http://localhost:${server.port}/api/users?limit=100`,
    );
    assertEquals(response.status, 400);
    await response.body?.cancel();
  } finally {
    server.close();
  }
});

Deno.test("E2E: GET /api/users/:id returns single user", async () => {
  const server = startTestServer();
  try {
    const response = await fetch(
      `http://localhost:${server.port}/api/users/1`,
    );

    assertEquals(response.status, 200);
    const data = await response.json();

    assertEquals(data.id, "1");
    assertEquals(data.name, "Alice");
    assertEquals(data.email, "alice@example.com");
  } finally {
    server.close();
  }
});

Deno.test("E2E: GET /api/users/:id returns 404 for unknown user", async () => {
  const server = startTestServer();
  try {
    const response = await fetch(
      `http://localhost:${server.port}/api/users/999`,
    );

    assertEquals(response.status, 404);
    const data = await response.json();
    assertEquals(data.error, "User not found");
  } finally {
    server.close();
  }
});

Deno.test("E2E: POST /api/users creates user", async () => {
  const server = startTestServer();
  try {
    const response = await fetch(`http://localhost:${server.port}/api/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Dave", email: "dave@example.com" }),
    });

    assertEquals(response.status, 201);
    const data = await response.json();

    assertEquals(data.name, "Dave");
    assertEquals(data.email, "dave@example.com");
  } finally {
    server.close();
  }
});

Deno.test("E2E: POST /api/users with invalid body returns 400", async () => {
  const server = startTestServer();
  try {
    const response = await fetch(`http://localhost:${server.port}/api/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "", email: "not-an-email" }),
    });

    assertEquals(response.status, 400);
    await response.body?.cancel();
  } finally {
    server.close();
  }
});

Deno.test("E2E: GET /api/events returns SSE stream", async () => {
  const server = startTestServer();
  try {
    const response = await fetch(`http://localhost:${server.port}/api/events`);

    assertEquals(response.status, 200);
    assertEquals(response.headers.get("Content-Type"), "text/event-stream");
    assertEquals(response.headers.get("Cache-Control"), "no-cache");

    const text = await response.text();

    // Verify SSE format
    assertStringIncludes(text, 'event: message\ndata: {"text":"Message 1"}');
    assertStringIncludes(text, 'event: message\ndata: {"text":"Message 2"}');
    assertStringIncludes(text, 'event: message\ndata: {"text":"Message 3"}');
    assertStringIncludes(text, 'event: done\ndata: {"count":3}');
  } finally {
    server.close();
  }
});

Deno.test("E2E: __apiDef metadata is properly attached", () => {
  // Verify handlers have __apiDef with pagination metadata
  const usersApiDef = usersHandlers.__apiDef;
  assertEquals(usersApiDef.GET !== undefined, true);
  assertEquals(usersApiDef.POST !== undefined, true);

  // deno-lint-ignore no-explicit-any
  const getPagination = (usersApiDef.GET as any).__pagination;
  assertEquals(getPagination.style, "cursor");
  assertEquals(getPagination.items, "data");
  assertEquals(getPagination.cursor, "nextCursor");

  // SSE handlers should have events metadata
  const eventsApiDef = eventsHandlers.__apiDef;
  assertEquals("events" in eventsApiDef.GET!, true);
});

/**
 * The Bun adapter, as far as it can be exercised without Bun: its handlers
 * take a standard `Request` with `params`. The same module under
 * `Bun.serve()` is covered by e2e_tests/bun (scripts/test-bun).
 */

import { assertEquals, assertRejects } from "@std/assert";
import { z } from "zod";
import {
  type BunRequest,
  createApiHandlers,
  endpoint,
  fileRoutes,
  sseEndpoint,
  toBunRoutePattern,
} from "./bun.ts";

function request(
  url: string,
  init: RequestInit & { params?: Record<string, string> } = {},
): BunRequest {
  const { params, ...rest } = init;
  return Object.assign(new Request(url, rest), { params });
}

const users = createApiHandlers({
  GET: endpoint({
    params: z.object({ id: z.string().regex(/^\d+$/) }),
    query: z.object({ verbose: z.coerce.boolean().default(false) }),
    response: z.object({ id: z.string(), verbose: z.boolean() }),
    handler: (req, { params, query }) =>
      Response.json({
        id: params.id,
        verbose: query.verbose,
        // The context is Bun's request itself.
        sameParams: req.params?.id === params.id,
      }),
  }),
  PUT: endpoint({
    body: z.object({ name: z.string() }),
    handler: (_req, { body }) => Response.json({ name: body.name }),
  }),
});

Deno.test("bun createApiHandlers: validated params and query reach the handler", async () => {
  const response = await users.GET(
    request("http://localhost/api/users/7?verbose=1", { params: { id: "7" } }),
  );

  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    id: "7",
    verbose: true,
    sameParams: true,
  });
});

Deno.test("bun createApiHandlers: invalid input is answered with 400", async () => {
  const badParam = await users.GET(
    request("http://localhost/api/users/x", { params: { id: "x" } }),
  );
  assertEquals(badParam.status, 400);

  const badBody = await users.PUT(
    request("http://localhost/api/users/7", {
      method: "PUT",
      body: JSON.stringify({ name: 1 }),
      params: { id: "7" },
    }),
  );
  assertEquals(badBody.status, 400);
  assertEquals(typeof (await badBody.json()).error, "string");
});

Deno.test("bun createApiHandlers: a request without params has none", async () => {
  const handlers = createApiHandlers({
    GET: endpoint({
      handler: (_req, { params }) => Response.json({ params }),
    }),
  });

  const response = await handlers.GET(request("http://localhost/api/health"));
  assertEquals(await response.json(), { params: {} });
});

Deno.test("bun createApiHandlers: the route object has only method keys", () => {
  // Bun reads the keys of a route object as HTTP methods.
  assertEquals(Object.keys(users), ["GET", "PUT"]);
  assertEquals({ ...users }.GET, users.GET);

  // The definitions are attached for the generators, without handlers.
  assertEquals(Object.keys(users.__apiDef), ["GET", "PUT"]);
  assertEquals("handler" in users.__apiDef.GET, false);
  assertEquals(users.__apiDef.GET.params instanceof z.ZodType, true);
});

Deno.test("bun sseEndpoint: events are streamed", async () => {
  const handlers = createApiHandlers({
    GET: sseEndpoint({
      events: { tick: z.object({ n: z.number() }) },
      async *handler() {
        yield { event: "tick", data: { n: 1 } };
        yield { event: "tick", data: { n: 2 }, id: "last" };
      },
    }),
  });

  const response = await handlers.GET(request("http://localhost/api/ticks"));

  assertEquals(response.headers.get("Content-Type"), "text/event-stream");
  assertEquals(
    await response.text(),
    'event: tick\ndata: {"n":1}\n\nevent: tick\nid: last\ndata: {"n":2}\n\n',
  );
});

Deno.test("toBunRoutePattern: parameters and catch-alls", () => {
  assertEquals(toBunRoutePattern("/api/users"), "/api/users");
  assertEquals(toBunRoutePattern("/api/users/[id]"), "/api/users/:id");
  assertEquals(
    toBunRoutePattern("/api/users/[id]/posts/[postId]"),
    "/api/users/:id/posts/:postId",
  );
  assertEquals(toBunRoutePattern("/api/files/[...path]"), "/api/files/*");
  assertEquals(toBunRoutePattern("/"), "/");
});

Deno.test("fileRoutes: one route per file that exports a handler", async () => {
  const dir = new URL("../tsgen/fixtures/edge/routes/api", import.meta.url)
    .pathname;

  const routes = await fileRoutes(dir);

  assertEquals(Object.keys(routes).sort(), [
    "/api/categories",
    "/api/jobs/:id",
    "/api/users/:id/posts",
    "/api/users/:id/posts/:postId",
  ]);
  assertEquals(typeof routes["/api/jobs/:id"].GET, "function");
});

Deno.test("fileRoutes: a directory that does not exist is an error", async () => {
  await assertRejects(() => fileRoutes("no/such/routes"));
});

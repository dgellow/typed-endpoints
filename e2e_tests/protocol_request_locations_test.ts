/**
 * E2E: a protocol step composed from an endpoint sends each request field
 * where the endpoint reads it: path, query string or JSON body.
 *
 * The handlers are real `createApiHandlers` handlers behind a real HTTP
 * server, so the request is validated by the endpoint's own schemas. The
 * body schemas are strict: a path or query field that leaked into the body
 * would be rejected with a 400.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { z } from "zod";

import { createApiHandlers, endpoint } from "../src/integrations/fresh.ts";
import {
  createHttpExecutor,
  createSession,
  fromEndpoint,
  fromEndpointMapped,
  fromStep,
  protocol,
  step,
} from "../src/protocol/index.ts";

// routes/api/users/[userId]/posts.ts
const postsHandler = createApiHandlers({
  GET: endpoint({
    params: z.object({ userId: z.string() }),
    query: z.object({
      limit: z.coerce.number().int(),
      tag: z.array(z.string()),
    }),
    response: z.object({
      userId: z.string(),
      limit: z.number(),
      tags: z.array(z.string()),
    }),
    handler: (_ctx, { params, query }) =>
      Response.json({
        userId: params.userId,
        limit: query.limit,
        tags: query.tag,
      }),
  }),
});

// routes/api/users/[userId].ts
const userHandler = createApiHandlers({
  PUT: endpoint({
    params: z.object({ userId: z.string() }),
    query: z.object({ notify: z.enum(["yes", "no"]) }),
    body: z.strictObject({ name: z.string() }),
    response: z.object({
      userId: z.string(),
      name: z.string(),
      notify: z.string(),
    }),
    handler: (_ctx, { params, query, body }) =>
      Response.json({
        userId: params.userId,
        name: body.name,
        notify: query.notify,
      }),
  }),
});

const routes = {
  listPosts: { method: "GET", path: "/api/users/{userId}/posts" },
  renameUser: { method: "PUT", path: "/api/users/{userId}" },
} as const;

const usersProtocol = protocol({
  name: "Users",
  initial: "listPosts",
  steps: {
    listPosts: fromEndpoint(postsHandler, "GET", {
      name: "listPosts",
      operationId: "listPosts",
    }),
    renameUser: fromEndpointMapped(userHandler, "PUT", {
      name: "renameUser",
      operationId: "renameUser",
      dependsOn: "listPosts",
      requestMapping: { userId: fromStep("listPosts", "userId") },
    }),
  },
});

/** Serve the two handlers; path parameters are matched like Fresh does. */
function startServer(): { baseUrl: string; close: () => Promise<void> } {
  const table: [RegExp, typeof postsHandler][] = [
    [/^\/api\/users\/(?<userId>[^/]+)\/posts$/, postsHandler],
    [/^\/api\/users\/(?<userId>[^/]+)$/, userHandler],
  ];

  const server = Deno.serve({ port: 0, onListen: () => {} }, async (req) => {
    const { pathname } = new URL(req.url);
    for (const [pattern, handlers] of table) {
      const match = pattern.exec(pathname);
      const handler = handlers[req.method];
      if (match && handler) {
        const params = Object.fromEntries(
          Object.entries(match.groups ?? {})
            .map(([key, value]) => [key, decodeURIComponent(value)]),
        );
        // deno-lint-ignore no-explicit-any
        return await handler({ req, params } as any);
      }
    }
    return new Response("Not Found", { status: 404 });
  });

  return {
    baseUrl: `http://localhost:${server.addr.port}`,
    close: () => server.shutdown(),
  };
}

Deno.test("E2E: composed steps send path, query and body fields to their place", async () => {
  const server = startServer();
  try {
    const executor = createHttpExecutor(usersProtocol, {
      baseUrl: server.baseUrl,
      routes,
    });
    const session = createSession(usersProtocol, executor);

    // GET: `userId` in the path, `limit` and the list `tag` in the query.
    const { response: posts, session: afterList } = await session.execute(
      "listPosts",
      { userId: "u 1", limit: 5, tag: ["a", "b"] },
    );
    assertEquals(posts, { userId: "u 1", limit: 5, tags: ["a", "b"] });

    // PUT: `userId` in the path, `notify` in the query, `name` in the body.
    // The strict body schema accepts the request, so nothing else is in it.
    const { response: renamed } = await afterList.execute("renameUser", {
      userId: "u 1",
      notify: "yes",
      name: "Ada",
    });
    assertEquals(renamed, { userId: "u 1", name: "Ada", notify: "yes" });
  } finally {
    await server.close();
  }
});

Deno.test("E2E: a hand-written GET step sends its fields as query parameters", async () => {
  const server = startServer();
  try {
    const proto = protocol({
      name: "HandWritten",
      initial: "listPosts",
      steps: {
        // No requestLocations: path parameters by name, the rest as query.
        listPosts: step({
          name: "listPosts",
          request: z.object({
            userId: z.string(),
            limit: z.number(),
            tag: z.array(z.string()),
          }),
          response: z.object({
            userId: z.string(),
            limit: z.number(),
            tags: z.array(z.string()),
          }),
        }),
      },
    });

    const executor = createHttpExecutor(proto, {
      baseUrl: server.baseUrl,
      routes,
    });
    const { response } = await createSession(proto, executor).execute(
      "listPosts",
      { userId: "u2", limit: 3, tag: ["x"] },
    );

    assertEquals(response, { userId: "u2", limit: 3, tags: ["x"] });
  } finally {
    await server.close();
  }
});

Deno.test("E2E: a missing path parameter is an error before any request is sent", async () => {
  let requests = 0;
  const proto = protocol({
    name: "MissingParam",
    initial: "listPosts",
    steps: {
      listPosts: step({
        name: "listPosts",
        request: z.object({ limit: z.number() }),
        response: z.unknown(),
      }),
    },
  });

  const executor = createHttpExecutor(proto, {
    baseUrl: "http://localhost:1",
    routes,
    fetch: () => {
      requests++;
      return Promise.resolve(Response.json({}));
    },
  });

  await assertRejects(
    () => createSession(proto, executor).execute("listPosts", { limit: 1 }),
    Error,
    'Step "listPosts": the request has no value for path parameter "userId" of GET /api/users/{userId}/posts',
  );
  assertEquals(requests, 0);
});

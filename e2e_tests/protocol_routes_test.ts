/**
 * E2E: a step made from an endpoint finds its route.
 *
 * Three places name an operation: `fromEndpoint()`, the generated route
 * table (`--format routes`) and the HTTP executor. Given the endpoint's
 * path, a step carries its route and the operationId the generator derives
 * for it, so nothing has to be written twice to connect them.
 */

import { assertEquals } from "@std/assert";

import { generateOpenApiSpec } from "@/core/openapi.ts";
import { generateTypes } from "@/tsgen/mod.ts";
import {
  addProtocolToSpec,
  createHttpExecutor,
  fromEndpoint,
  type HandlerWithApiDef,
  protocol,
} from "@/protocol/index.ts";

import { handler as files } from "./fixtures/nested/routes/api/files/[...path].ts";
import { handler as session } from "./fixtures/nested/routes/api/session.ts";
import { handler as events } from "./fixtures/nested/routes/api/users/[id]/events.ts";
import { handler as posts } from "./fixtures/nested/routes/api/users/[id]/posts.ts";
import { handler as post } from "./fixtures/nested/routes/api/users/[id]/posts/[postId].ts";
import { handler as tags } from "./fixtures/nested/routes/api/users/[id]/tags.ts";
import { handler as health } from "./fixtures/nested/routes/health.ts";
import { handler as reports } from "../src/core/fixtures/described/routes/api/reports.ts";
import { handler as reportTags } from "../src/core/fixtures/described/routes/api/reports/[id]/tags.ts";

/** Every endpoint of the fixture, with the file-route form of its path. */
const ENDPOINTS: [HandlerWithApiDef, string][] = [
  [files, "/api/files/[...path]"],
  [session, "/api/session"],
  [events, "/api/users/[id]/events"],
  [posts, "/api/users/[id]/posts"],
  [post, "/api/users/[id]/posts/[postId]"],
  [tags, "/api/users/[id]/tags"],
  [health, "/health"],
];

Deno.test("E2E: fromEndpoint derives the operationId the route generator writes", async () => {
  const generated = await generateTypes({
    routesDirs: ["e2e_tests/fixtures/nested/routes"],
    format: "routes",
  });
  // `usersPostsList: { method: "GET", path: "/api/users/{id}/posts" },`
  const table = new Map(
    [...generated.matchAll(
      /^\s+(\w+): \{ method: "(\w+)", path: "([^"]+)" \},$/gm,
    )].map(([, id, method, path]) => [`${method} ${path}`, id]),
  );
  assertEquals(table.size > 0, true);

  let compared = 0;
  for (const [handler, path] of ENDPOINTS) {
    for (const method of Object.keys(handler.__apiDef)) {
      // deno-lint-ignore no-explicit-any
      const step = fromEndpoint(handler, method as any, { name: "s", path });
      assertEquals(
        step.operationId,
        table.get(`${method} ${step.route!.path}`),
        `${method} ${path}`,
      );
      compared++;
    }
  }
  // Every route of the table was compared.
  assertEquals(compared, table.size);
});

Deno.test("E2E: steps with a path are served without a route table", async () => {
  const getPost = fromEndpoint(post, "GET", {
    name: "getPost",
    path: "/api/users/[id]/posts/[postId]",
  });
  const ping = fromEndpoint(health, "GET", { name: "ping", path: "/health" });
  const proto = protocol({
    name: "Posts",
    initial: "ping",
    steps: { ping, getPost },
  });

  const handlers = {
    "/health": health,
    "/api/users/u1/posts/p7": post,
  } as Record<string, Record<string, unknown>>;
  const server = Deno.serve({ port: 0, onListen: () => {} }, (request) => {
    const { pathname } = new URL(request.url);
    const handle = handlers[pathname]?.[request.method] as
      | ((request: Request, params: unknown) => Promise<Response>)
      | undefined;
    return handle
      ? handle(request, { id: "u1", postId: "p7" })
      : new Response("Not Found", { status: 404 });
  });

  try {
    const executor = createHttpExecutor(proto, {
      baseUrl: `http://localhost:${server.addr.port}`,
    });
    const context = { protocol: "Posts", history: [], responses: {} };

    assertEquals(await executor.execute("ping", {}, context), { ok: true });
    assertEquals(
      await executor.execute("getPost", { id: "u1", postId: "p7" }, context),
      { id: "p7", userId: "u1", title: "stored" },
    );
  } finally {
    await server.shutdown();
  }
});

Deno.test("E2E: a step in x-protocols names an operation of the generated spec", async () => {
  // The protocol's steps and the document's operations come from the
  // same handlers; nothing names an operation by hand.
  const proto = protocol({
    name: "Reports",
    initial: "create",
    steps: {
      create: fromEndpoint(reports, "POST", {
        name: "create",
        path: "/api/reports",
      }),
      list: fromEndpoint(reports, "GET", {
        name: "list",
        path: "/api/reports",
      }),
      untag: fromEndpoint(reportTags, "DELETE", {
        name: "untag",
        path: "/api/reports/[id]/tags",
      }),
    },
  });

  const spec = addProtocolToSpec(
    await generateOpenApiSpec({
      routesDir: "src/core/fixtures/described/routes/api",
    }),
    proto,
  );

  const operations = new Map<string, string>();
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(item ?? {})) {
      const id = (operation as { operationId?: string }).operationId;
      if (id) operations.set(id, `${method.toUpperCase()} ${path}`);
    }
  }

  const [listed] = spec["x-protocols"];
  assertEquals(
    listed.steps.map((step) => [
      step.name,
      operations.get(step.operationId ?? ""),
    ]),
    [
      ["create", "POST /api/reports"],
      ["list", "GET /api/reports"],
      ["untag", "DELETE /api/reports/{id}/tags"],
    ],
  );
});

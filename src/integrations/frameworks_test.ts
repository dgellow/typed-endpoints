/**
 * The framework integrations.
 *
 * Each integration is exercised with the arguments its framework passes to
 * a handler, as the framework documents them, and with route files in the
 * framework's own layout. Hono and h3 are light enough to install: the
 * same integrations run inside the real frameworks in e2e_tests/bun.
 * Next.js, SvelteKit and Astro are not run here; their handler types are
 * checked against the real packages by scripts/check-framework-types.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { z } from "zod";

import { generateOpenApiSpec } from "../core/openapi.ts";
import { type RouteConvention, routeOfFile } from "../core/routes.ts";
import { generateTypes } from "../tsgen/mod.ts";
import * as astro from "./astro.ts";
import * as fetchRoutes from "./fetch.ts";
import * as hono from "./hono.ts";
import * as next from "./next.ts";
import * as nitro from "./nitro.ts";
import * as sveltekit from "./sveltekit.ts";

const FIXTURES = new URL("./fixtures", import.meta.url).pathname;

const Params = z.object({ id: z.string().regex(/^\d+$/) });
const Body = z.object({ name: z.string() });

function json(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

// =============================================================================
// Route conventions
// =============================================================================

Deno.test("routeOfFile: where each framework keeps a route and how it spells the path", () => {
  const cases: [RouteConvention, string, unknown][] = [
    ["fresh", "routes/api/users/[id].ts", { apiPath: "/api/users/[id]" }],
    ["fresh", "/abs/app/routes/(auth)/api/login.ts", { apiPath: "/api/login" }],
    ["fresh", "routes/api/users/index.ts", { apiPath: "/api/users" }],

    ["next", "app/api/users/[id]/route.ts", { apiPath: "/api/users/[id]" }],
    ["next", "src/app/api/users/route.ts", { apiPath: "/api/users" }],
    ["next", "app/(admin)/api/reports/[[...slug]]/route.ts", {
      apiPath: "/api/reports/[...slug]",
    }],
    ["next", "app/@modal/api/x/route.ts", { apiPath: "/api/x" }],
    ["next", "app/route.ts", { apiPath: "/" }],
    // Only route.ts files are endpoints.
    ["next", "app/api/users/helpers.ts", undefined],
    ["next", "app/api/users/page.tsx", undefined],

    ["sveltekit", "src/routes/api/users/[id]/+server.ts", {
      apiPath: "/api/users/[id]",
    }],
    ["sveltekit", "src/routes/(app)/api/health/+server.ts", {
      apiPath: "/api/health",
    }],
    ["sveltekit", "src/routes/api/items/[id=integer]/+server.ts", {
      apiPath: "/api/items/[id]",
    }],
    ["sveltekit", "src/routes/api/[[lang]]/docs/[...rest]/+server.ts", {
      apiPath: "/api/[lang]/docs/[...rest]",
    }],
    ["sveltekit", "src/routes/+server.ts", { apiPath: "/" }],
    ["sveltekit", "src/routes/api/users/+page.server.ts", undefined],

    ["astro", "src/pages/api/users/[id].ts", { apiPath: "/api/users/[id]" }],
    ["astro", "src/pages/api/users/index.ts", { apiPath: "/api/users" }],
    ["astro", "src/pages/api/files/[...path].ts", {
      apiPath: "/api/files/[...path]",
    }],

    ["nitro", "server/api/users/[id].get.ts", {
      apiPath: "/api/users/[id]",
      method: "GET",
    }],
    ["nitro", "server/api/users/index.post.ts", {
      apiPath: "/api/users",
      method: "POST",
    }],
    // server/routes is served from the root.
    ["nitro", "server/routes/health.get.ts", {
      apiPath: "/health",
      method: "GET",
    }],
    ["nitro", "server/api/anything.ts", { apiPath: "/api/anything" }],
  ];

  for (const [convention, file, expected] of cases) {
    assertEquals(
      routeOfFile(file, convention),
      expected,
      `${convention} ${file}`,
    );
  }
});

// =============================================================================
// Generation from each layout
// =============================================================================

const LAYOUTS: [RouteConvention, string, string[]][] = [
  ["next", "next/app", [
    "DELETE /api/users/{id}",
    "GET /api/reports/{slug}",
    "GET /api/users",
    "GET /api/users/{id}",
    "POST /api/users",
  ]],
  ["sveltekit", "sveltekit/src/routes", [
    "GET /api/health",
    "GET /api/users",
    "GET /api/users/{id}",
    "POST /api/users",
  ]],
  ["astro", "astro/src/pages", [
    "GET /api/files/{path}",
    "GET /api/users",
    "GET /api/users/{id}",
  ]],
  ["nitro", "nitro/server", [
    "DELETE /api/users/{id}",
    "GET /api/users/{id}",
    "GET /health",
    "POST /api/users",
  ]],
  ["fresh", "fetch/routes", [
    "GET /api/users",
    "GET /api/users/{id}",
    "POST /api/users",
  ]],
];

for (const [convention, dir, operations] of LAYOUTS) {
  Deno.test(`generators read the ${convention} layout (${dir})`, async () => {
    const routesDir = `${FIXTURES}/${dir}`;

    const spec = await generateOpenApiSpec({
      routesDir,
      convention,
      strict: true,
    });
    const found = Object.entries(spec.paths ?? {}).flatMap(([path, item]) =>
      Object.keys(item as object).map((m) => `${m.toUpperCase()} ${path}`)
    ).sort();
    assertEquals(found, operations);

    // The same routes through the route table.
    const routes = await generateTypes({
      routesDirs: [routesDir],
      convention,
      format: "routes",
    });
    for (const operation of operations) {
      const [method, path] = operation.split(" ");
      assertEquals(
        routes.includes(`method: "${method}", path: "${path}"`),
        true,
        `${operation} in\n${routes}`,
      );
    }
  });
}

Deno.test("the same API in two layouts generates the same client types", async () => {
  const fromNext = await generateTypes({
    routesDirs: [`${FIXTURES}/next/app/api/users`],
    convention: "next",
    format: "client",
  });
  const fromSvelteKit = await generateTypes({
    routesDirs: [`${FIXTURES}/sveltekit/src/routes/api/users`],
    convention: "sveltekit",
    format: "client",
  });

  // Next's fixture has a query and a DELETE that SvelteKit's does not;
  // the methods both define have the same types.
  for (const line of ["create: {", "body: { name: string; };", "retrieve: {"]) {
    assertEquals(fromNext.includes(line), true, line);
    assertEquals(fromSvelteKit.includes(line), true, line);
  }
});

Deno.test("generation in a subprocess reads the same layouts", async () => {
  for (const [convention, dir] of LAYOUTS) {
    const options = {
      routesDirs: [`${FIXTURES}/${dir}`],
      convention,
      format: "types",
    } as const;
    assertEquals(
      await generateTypes({ ...options, config: "deno.json" }),
      await generateTypes(options),
      convention,
    );
  }
});

// =============================================================================
// Next.js: (request, { params: Promise })
// =============================================================================

Deno.test("next: params arrive as a promise in the second argument", async () => {
  const { GET, PUT } = next.createApiHandlers({
    GET: next.endpoint({
      params: Params,
      handler: (request, { params }) =>
        Response.json({ id: params.id, url: request.url }),
    }),
    PUT: next.endpoint({
      params: Params,
      body: Body,
      handler: (_request, { params, body }) =>
        Response.json({ id: params.id, name: body.name }),
    }),
  });

  const ok = await GET(new Request("http://x/api/users/7"), {
    params: Promise.resolve({ id: "7" }),
  });
  assertEquals(await ok.json(), { id: "7", url: "http://x/api/users/7" });

  const updated = await PUT(
    new Request("http://x/api/users/7", json("PUT", { name: "Ada" })),
    { params: Promise.resolve({ id: "7" }) },
  );
  assertEquals(await updated.json(), { id: "7", name: "Ada" });

  const invalid = await GET(new Request("http://x/api/users/x"), {
    params: Promise.resolve({ id: "x" }),
  });
  assertEquals(invalid.status, 400);

  // Next.js 14 passed a plain object; a route without segments passes none.
  assertEquals(
    (await GET(new Request("http://x/api/users/8"), { params: { id: "8" } }))
      .status,
    200,
  );
  assertEquals((await GET(new Request("http://x/api/users"))).status, 400);
});

Deno.test("next: each exported function carries its definition", async () => {
  const mod = await import("./fixtures/next/app/api/users/[id]/route.ts");

  assertEquals(Object.keys(mod).sort(), ["DELETE", "GET", "dynamic"]);
  assertEquals(mod.GET.__methodDef.params instanceof z.ZodType, true);
  assertEquals("handler" in mod.GET.__methodDef, false);

  const response = await mod.GET(new Request("http://x/api/users/2"), {
    params: Promise.resolve({ id: "2" }),
  });
  assertEquals(await response.json(), { id: "2", name: "Grace" });
});

Deno.test("next: an optional catch-all is an array of segments", async () => {
  const mod = await import(
    "./fixtures/next/app/(admin)/api/reports/[[...slug]]/route.ts"
  );

  const deep = await mod.GET(new Request("http://x/api/reports/2026/q1"), {
    params: Promise.resolve({ slug: ["2026", "q1"] }),
  });
  assertEquals(await deep.json(), { path: "2026/q1" });

  const root = await mod.GET(new Request("http://x/api/reports"), {
    params: Promise.resolve({}),
  });
  assertEquals(await root.json(), { path: "" });
});

// =============================================================================
// SvelteKit and Astro: (event) with request and params
// =============================================================================

Deno.test("sveltekit: the event gives the request and the params", async () => {
  const mod = await import(
    "./fixtures/sveltekit/src/routes/api/users/[id]/+server.ts"
  );
  const event = (id: string) => ({
    request: new Request(`http://x/api/users/${id}`),
    params: { id },
    url: new URL(`http://x/api/users/${id}`),
    locals: {},
  });

  assertEquals(await (await mod.GET(event("1"))).json(), {
    id: "1",
    name: "Ada",
  });
  assertEquals((await mod.GET(event("nope"))).status, 400);
  assertEquals((await mod.GET(event("9"))).status, 404);
});

Deno.test("sveltekit: withEvent types the handler with the app's event", async () => {
  interface AppEvent extends sveltekit.SvelteKitEvent {
    readonly locals: { readonly userId: string };
  }
  const { endpoint, createApiHandlers } = sveltekit.withEvent<AppEvent>();

  const { GET } = createApiHandlers({
    GET: endpoint({
      // `locals` is typed.
      handler: (event) => Response.json({ user: event.locals.userId }),
    }),
  });

  const response = await GET({
    request: new Request("http://x/api/me"),
    params: {},
    locals: { userId: "u-1" },
  });
  assertEquals(await response.json(), { user: "u-1" });
});

Deno.test("astro: the context gives the request and the params", async () => {
  const user = await import("./fixtures/astro/src/pages/api/users/[id].ts");
  const files = await import(
    "./fixtures/astro/src/pages/api/files/[...path].ts"
  );
  const context = (
    path: string,
    params: Record<string, string | undefined>,
  ) => ({
    request: new Request(`http://x${path}`),
    params,
  });

  assertEquals(
    await (await user.GET(context("/api/users/2", { id: "2" }))).json(),
    { id: "2", name: "Grace" },
  );
  // Astro passes a rest parameter as one string.
  assertEquals(
    await (await files.GET(context("/api/files/a/b.txt", { path: "a/b.txt" })))
      .json(),
    { path: "a/b.txt" },
  );
  // A parameter Astro leaves undefined is a missing parameter.
  assertEquals(
    (await user.GET(context("/api/users", { id: undefined }))).status,
    400,
  );
});

// =============================================================================
// Nitro / h3: (event) with req and context.params
// =============================================================================

Deno.test("nitro: a default export handles the method its file names", async () => {
  const get = await import("./fixtures/nitro/server/api/users/[id].get.ts");
  const post = await import("./fixtures/nitro/server/api/users/index.post.ts");
  const event = (request: Request, params?: Record<string, string>) => ({
    req: request,
    context: { params },
  });

  const found = await get.default(
    event(new Request("http://x/api/users/1"), { id: "1" }),
  );
  assertEquals(await found.json(), { id: "1", name: "Ada" });

  const created = await post.default(
    event(new Request("http://x/api/users", json("POST", { name: "Edsger" }))),
  );
  assertEquals(await created.json(), { id: "3", name: "Edsger" });

  const invalid = await post.default(
    event(new Request("http://x/api/users", json("POST", { name: 1 }))),
  );
  assertEquals(invalid.status, 400);

  assertEquals(get.default.__methodDef.params instanceof z.ZodType, true);
});

Deno.test("nitro: a file without a method suffix answers every method", async () => {
  const mod = await import("./fixtures/nitro/server/api/anything.ts");

  for (const method of ["GET", "DELETE", "PATCH"]) {
    const response = await mod.default({
      req: new Request("http://x/api/anything", { method }),
      context: {},
    });
    assertEquals(await response.json(), { method });
  }
});

Deno.test("nitro: createApiHandlers gives handlers by method for an h3 app", async () => {
  const { GET } = nitro.createApiHandlers({
    GET: nitro.endpoint({
      params: Params,
      handler: (_event, { params }) => Response.json(params),
    }),
  });

  const response = await GET({
    req: new Request("http://x/users/5"),
    context: { params: { id: "5" } },
  });
  assertEquals(await response.json(), { id: "5" });
});

// =============================================================================
// Hono: (c) with c.req.raw and c.req.param()
// =============================================================================

function honoContext(request: Request, params: Record<string, string> = {}) {
  return { req: { raw: request, param: () => params } };
}

Deno.test("hono: the context gives the request and the params", async () => {
  const { GET, POST } = hono.createApiHandlers({
    GET: hono.endpoint({
      params: Params,
      handler: (c, { params }) =>
        Response.json({ id: params.id, method: c.req.raw.method }),
    }),
    POST: hono.endpoint({
      body: Body,
      handler: (_c, { body }) => Response.json(body),
    }),
  });

  const ok = await GET(
    honoContext(new Request("http://x/users/4"), { id: "4" }),
  );
  assertEquals(await ok.json(), { id: "4", method: "GET" });

  const invalid = await GET(
    honoContext(new Request("http://x/users/x"), { id: "x" }),
  );
  assertEquals(invalid.status, 400);

  const created = await POST(
    honoContext(new Request("http://x/users", json("POST", { name: "Ada" }))),
  );
  assertEquals(await created.json(), { name: "Ada" });
});

Deno.test("hono: paths and mounting a directory of route files", async () => {
  assertEquals(hono.toHonoPath("/api/users/[id]"), "/api/users/:id");
  assertEquals(hono.toHonoPath("/api/files/[...path]"), "/api/files/:path{.+}");
  assertEquals(hono.toHonoPath("/"), "/");

  const registered: string[] = [];
  const app = {
    on(method: string, path: string) {
      registered.push(`${method} ${path}`);
    },
  };

  const paths = await hono.mountFileRoutes(app, `${FIXTURES}/fetch/routes`);

  assertEquals(paths, [
    "/api/files/:path{.+}",
    "/api/users",
    "/api/users/:id",
    "/api/users/me",
  ]);
  assertEquals(registered, [
    "GET /api/files/:path{.+}",
    "GET /api/users",
    "POST /api/users",
    "GET /api/users/:id",
    "GET /api/users/me",
  ]);
});

// =============================================================================
// Plain fetch: (request, params) and a router
// =============================================================================

Deno.test("fetch: createRouter matches static segments before parameters before catch-alls", async () => {
  const which = (name: string) => ({
    GET: (_request: Request, params?: fetchRoutes.RouteParams) =>
      Response.json({ name, params }),
  });
  const router = fetchRoutes.createRouter({
    "/files/[...path]": which("files"),
    "/users/[id]": which("user"),
    "/users/me": which("me"),
    "/users/:id/posts/:postId": which("post"),
    "/": which("root"),
    "/assets/*": which("assets"),
  });
  const at = async (path: string) =>
    await (await router(new Request(`http://x${path}`))).json();

  assertEquals(await at("/users/me"), { name: "me", params: {} });
  assertEquals(await at("/users/7"), { name: "user", params: { id: "7" } });
  assertEquals(await at("/users/7/posts/9"), {
    name: "post",
    params: { id: "7", postId: "9" },
  });
  assertEquals(await at("/files/a/b/c.txt"), {
    name: "files",
    params: { path: "a/b/c.txt" },
  });
  assertEquals(await at("/assets/img/logo.png"), {
    name: "assets",
    params: { rest: "img/logo.png" },
  });
  assertEquals(await at("/"), { name: "root", params: {} });
  // Values are URL-decoded.
  assertEquals(await at("/users/a%20b"), {
    name: "user",
    params: { id: "a b" },
  });
});

Deno.test("fetch: createRouter answers 404, 405 and a custom notFound", async () => {
  const router = fetchRoutes.createRouter({
    "/users": { GET: () => new Response("ok"), POST: () => new Response("ok") },
  });

  const missing = await router(new Request("http://x/nope"));
  assertEquals(missing.status, 404);
  assertEquals(await missing.json(), { error: "Not found" });

  const wrongMethod = await router(
    new Request("http://x/users", { method: "DELETE" }),
  );
  assertEquals(wrongMethod.status, 405);
  assertEquals(wrongMethod.headers.get("Allow"), "GET, POST");

  // A longer path is not a match for a shorter route.
  assertEquals((await router(new Request("http://x/users/1"))).status, 404);

  const custom = fetchRoutes.createRouter({}, {
    notFound: () => new Response("custom", { status: 418 }),
  });
  assertEquals((await custom(new Request("http://x/x"))).status, 418);
});

Deno.test("fetch: fileRouter serves a directory of route files", async () => {
  const router = await fetchRoutes.fileRouter(`${FIXTURES}/fetch/routes`);
  const get = (path: string) => router(new Request(`http://x${path}`));

  assertEquals(await (await get("/api/users/2")).json(), {
    id: "2",
    name: "Grace",
  });
  assertEquals(await (await get("/api/users/me")).json(), { id: "me" });
  assertEquals((await get("/api/users/abc")).status, 400);
  assertEquals(await (await get("/api/files/docs/a.md")).json(), {
    path: "docs/a.md",
  });

  const created = await router(
    new Request("http://x/api/users", json("POST", { name: "Edsger" })),
  );
  assertEquals(await created.json(), { id: "3", name: "Edsger" });

  await assertRejects(() => fetchRoutes.fileRouter("no/such/routes"));
});

Deno.test("fetch: a real server with Deno.serve", async () => {
  const controller = new AbortController();
  const server = Deno.serve(
    { port: 0, signal: controller.signal, onListen: () => {} },
    await fetchRoutes.fileRouter(`${FIXTURES}/fetch/routes`),
  );
  try {
    const response = await fetch(
      `http://localhost:${server.addr.port}/api/users/1`,
    );
    assertEquals(await response.json(), { id: "1", name: "Ada" });
  } finally {
    controller.abort();
    await server.finished;
  }
});

// =============================================================================
// Shared behaviour
// =============================================================================

Deno.test("every integration streams server-sent events", async () => {
  const events = { tick: z.object({ n: z.number() }) };
  async function* ticks() {
    yield { event: "tick" as const, data: { n: 1 } };
  }
  const request = new Request("http://x/ticks");
  const expected = 'event: tick\ndata: {"n":1}\n\n';

  const responses = [
    await next.createApiHandlers({
      GET: next.sseEndpoint({ events, handler: ticks }),
    }).GET(request),
    await sveltekit.createApiHandlers({
      GET: sveltekit.sseEndpoint({ events, handler: ticks }),
    }).GET({ request, params: {} }),
    await astro.createApiHandlers({
      GET: astro.sseEndpoint({ events, handler: ticks }),
    }).GET({ request, params: {} }),
    await nitro.createHandler(nitro.sseEndpoint({ events, handler: ticks }))({
      req: request,
      context: {},
    }),
    await hono.createApiHandlers({
      GET: hono.sseEndpoint({ events, handler: ticks }),
    }).GET(honoContext(request)),
    await fetchRoutes.createApiHandlers({
      GET: fetchRoutes.sseEndpoint({ events, handler: ticks }),
    }).GET(request),
  ];

  for (const response of responses) {
    assertEquals(response.headers.get("Content-Type"), "text/event-stream");
    assertEquals(await response.text(), expected);
  }
});

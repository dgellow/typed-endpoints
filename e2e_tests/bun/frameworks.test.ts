/**
 * The Hono and h3 integrations inside the real frameworks.
 *
 * Run by scripts/test-bun, which installs both next to the package.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { H3 } from "h3";
import { Hono } from "hono";
import { z } from "zod";

import { generateOpenApiSpec } from "@dgellow/typed-endpoints";
import * as hono from "@dgellow/typed-endpoints/hono";
import * as nitro from "@dgellow/typed-endpoints/nitro";

const HONO_ROUTES = join(import.meta.dir, "hono-routes/routes");

function json(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

describe("hono", () => {
  test("handlers registered by hand", async () => {
    const users = hono.createApiHandlers({
      GET: hono.endpoint({
        params: z.object({ id: z.string().regex(/^\d+$/) }),
        query: z.object({ verbose: z.coerce.boolean().default(false) }),
        handler: (_c, { params, query }) =>
          Response.json({ id: params.id, verbose: query.verbose }),
      }),
    });

    const app = new Hono();
    app.get("/users/:id", users.GET);

    const ok = await app.request("/users/7?verbose=1");
    expect(await ok.json()).toEqual({ id: "7", verbose: true });

    const invalid = await app.request("/users/abc");
    expect(invalid.status).toBe(400);
  });

  test("a directory of route files mounted on an app", async () => {
    const app = new Hono();
    const paths = await hono.mountFileRoutes(app, HONO_ROUTES);
    expect(paths).toEqual(["/api/files/:path{.+}", "/api/users/:id"]);

    const user = await app.request("/api/users/2");
    expect(await user.json()).toEqual({ id: "2", via: "hono" });

    const updated = await app.request(
      "/api/users/2",
      json("PUT", { name: "Ada" }),
    );
    expect(await updated.json()).toEqual({ id: "2", name: "Ada" });

    const rejected = await app.request(
      "/api/users/2",
      json("PUT", { name: 1 }),
    );
    expect(rejected.status).toBe(400);

    // The catch-all is a named parameter that spans segments.
    const file = await app.request("/api/files/docs/a/b.md");
    expect(await file.json()).toEqual({ path: "docs/a/b.md" });

    // A method the route file does not define is not registered.
    expect((await app.request("/api/users/2", { method: "DELETE" })).status)
      .toBe(404);
  });

  test("the generators read the same directory", async () => {
    const spec = await generateOpenApiSpec({
      routesDir: HONO_ROUTES,
      strict: true,
    });
    expect(Object.keys(spec.paths ?? {})).toEqual(["/api/users/{id}"]);
  });

  test("server-sent events through Hono", async () => {
    const ticks = hono.createApiHandlers({
      GET: hono.sseEndpoint({
        events: { tick: z.object({ n: z.number() }) },
        async *handler() {
          yield { event: "tick", data: { n: 1 } };
        },
      }),
    });
    const app = new Hono();
    app.get("/ticks", ticks.GET);

    const response = await app.request("/ticks");
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(await response.text()).toBe('event: tick\ndata: {"n":1}\n\n');
  });
});

describe("h3 v2", () => {
  test("handlers by method on an h3 app", async () => {
    const users = nitro.createApiHandlers({
      GET: nitro.endpoint({
        params: z.object({ id: z.string().regex(/^\d+$/) }),
        handler: (_event, { params }) => Response.json({ id: params.id }),
      }),
      POST: nitro.endpoint({
        body: z.object({ name: z.string() }),
        handler: (_event, { body }) => Response.json({ name: body.name }),
      }),
    });

    const app = new H3();
    app.get("/users/:id", users.GET);
    app.post("/users", users.POST);

    const ok = await app.request("/users/7");
    expect(await ok.json()).toEqual({ id: "7" });

    const invalid = await app.request("/users/abc");
    expect(invalid.status).toBe(400);

    const created = await app.request("/users", json("POST", { name: "Ada" }));
    expect(await created.json()).toEqual({ name: "Ada" });

    const rejected = await app.request("/users", json("POST", { name: 1 }));
    expect(rejected.status).toBe(400);
  });

  test("a single handler, as a Nitro route file exports it", async () => {
    // What server/api/users/[id].get.ts default-exports.
    const handler = nitro.createHandler(nitro.endpoint({
      params: z.object({ id: z.string() }),
      query: z.object({ fields: z.array(z.string()).optional() }),
      handler: (event, { params, query }) =>
        Response.json({
          id: params.id,
          fields: query.fields ?? [],
          method: event.req.method,
        }),
    }));

    const app = new H3();
    app.all("/api/users/:id", handler);

    const response = await app.request("/api/users/3?fields=id&fields=name");
    expect(await response.json()).toEqual({
      id: "3",
      fields: ["id", "name"],
      method: "GET",
    });
  });
});

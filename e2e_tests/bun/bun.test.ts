/**
 * The package under Bun.
 *
 * Run by scripts/test-bun, which installs the library source as a package
 * in a throwaway Bun project; the imports below resolve as they do for a
 * consumer. Deno does not see this directory.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkResourceLaws,
  formatResourceLawsReport,
  generateOpenApiSpec,
  generateProtocolTypesFromModule,
  generateTypes,
} from "@dgellow/typed-endpoints";
import { fileRoutes, toBunRoutePattern } from "@dgellow/typed-endpoints/bun";
import { createClient } from "@dgellow/typed-endpoints/client";
import {
  createMockExecutor,
  createSession,
  oauth2AuthCodeProtocol,
} from "@dgellow/typed-endpoints/protocol";

const ROUTES = join(import.meta.dir, "routes/api");

let server: ReturnType<typeof Bun.serve>;
let base: string;
let scratch: string;

beforeAll(async () => {
  server = Bun.serve({ port: 0, routes: await fileRoutes(ROUTES) });
  base = `http://localhost:${server.port}`;
  scratch = await mkdtemp(join(tmpdir(), "typed-endpoints-bun-"));
});

afterAll(async () => {
  await server.stop(true);
  await rm(scratch, { recursive: true, force: true });
});

describe("fileRoutes with Bun.serve", () => {
  test("file paths become Bun route patterns", async () => {
    expect(Object.keys(await fileRoutes(ROUTES)).sort()).toEqual([
      "/api/files/*",
      "/api/notes/:id",
      "/api/ticks",
      "/api/users",
      "/api/users/:id",
    ]);
    expect(toBunRoutePattern("/a/[b]/c/[...rest]")).toBe("/a/:b/c/*");
  });

  test("a route object has only method keys", async () => {
    const routes = await fileRoutes(ROUTES);
    expect(Object.keys(routes["/api/users"])).toEqual(["GET", "POST"]);
    // The definitions are still there for the generators.
    expect("__apiDef" in routes["/api/users"]).toBe(true);
  });

  test("path parameters are validated and passed to the handler", async () => {
    const ok = await fetch(`${base}/api/users/2`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      id: "2",
      name: "Grace",
      email: "grace@example.test",
    });

    const invalid = await fetch(`${base}/api/users/abc`);
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error).toContain("id");
  });

  test("a body is validated", async () => {
    const created = await fetch(`${base}/api/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Edsger", email: "e@example.test" }),
    });
    expect(await created.json()).toEqual({
      id: "3",
      name: "Edsger",
      email: "e@example.test",
    });

    const invalid = await fetch(`${base}/api/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Edsger" }),
    });
    expect(invalid.status).toBe(400);
  });

  test("a method the route does not define is not served", async () => {
    const response = await fetch(`${base}/api/users/1`, { method: "DELETE" });
    expect(response.ok).toBe(false);
  });

  test("a catch-all file serves everything below it", async () => {
    const response = await fetch(`${base}/api/files/a/b/c.txt`);
    expect(await response.json()).toEqual({ path: "a/b/c.txt" });
  });
});

describe("typed client against Bun.serve", () => {
  test("requests, query lists and sparse fieldsets", async () => {
    // deno-lint-ignore no-explicit-any
    const client = createClient<any>(base);

    expect(await client.users.retrieve("1")).toEqual({
      id: "1",
      name: "Ada",
      email: "ada@example.test",
    });
    expect(
      await client.users.list({ query: { fields: ["id"], tag: ["a"] } }),
    ).toEqual({ data: [{ id: "1" }, { id: "2" }] });
  });

  test("server-sent events", async () => {
    // deno-lint-ignore no-explicit-any
    const client = createClient<any>(base);
    const seen: unknown[] = [];
    for await (
      const event of client.ticks.subscribe({
        query: { count: 3 },
        reconnect: false,
      })
    ) {
      seen.push(event);
    }
    expect(seen).toEqual([
      { event: "tick", data: { n: 0 }, id: "0" },
      { event: "tick", data: { n: 1 }, id: "1" },
      { event: "tick", data: { n: 2 }, id: "2" },
    ]);
  });

  test("a handler that throws cuts the stream, and the client resumes", async () => {
    // deno-lint-ignore no-explicit-any
    const client = createClient<any>(base);
    const seen: number[] = [];
    for await (
      const event of client.ticks.subscribe({
        query: { count: 4, failAt: 2 },
        reconnectDelay: 5,
      })
    ) {
      seen.push(event.data.n);
    }
    // The first connection failed before event 2. A normal end would have
    // left the client with [0, 1]; a cut stream made it reconnect with
    // Last-Event-ID: 1, and the second connection continued from there.
    expect(seen).toEqual([0, 1, 2, 3]);
  });
});

describe("resource laws against Bun.serve", () => {
  test("a resource obeys the laws; a PUT that merges fails put-put", async () => {
    const { handler } = await import("./routes/api/notes/[id].ts");

    // PUT creates the note: the laws that begin with GET need it to exist.
    const create = (id: string) =>
      fetch(`${base}/api/notes/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "First", tags: ["a"] }),
      });
    expect((await create("1")).status).toBe(200);
    expect((await create("merged")).status).toBe(200);

    const report = await checkResourceLaws(handler, {
      url: `${base}/api/notes/1`,
    });
    expect(report.ok, formatResourceLawsReport(report)).toBe(true);

    const merged = await checkResourceLaws(handler, {
      url: `${base}/api/notes/merged`,
      runs: 40,
    });
    expect(merged.ok).toBe(false);
    expect(
      Object.entries(merged.laws)
        .filter(([, law]) => law.held !== merged.runs)
        .map(([name]) => name),
    ).toEqual(["put-put"]);
    const places = merged.laws["put-put"]!.violations.flatMap((violation) =>
      violation.differences.map((difference) => difference.path)
    );
    expect([...new Set(places)]).toEqual(["pinned"]);
  });
});

describe("generators under Bun", () => {
  test("types, client and routes formats", async () => {
    const types = await generateTypes({ routesDirs: [ROUTES] });
    expect(types).toContain("export type UsersByIdParams = { id: string; };");
    expect(types).toContain("export type TicksEvents =");

    const client = await generateTypes({
      routesDirs: [ROUTES],
      format: "client",
    });
    expect(client).toContain(
      'import type { Dependent, Projection } from "@dgellow/typed-endpoints/client";',
    );
    expect(client).toContain("dependent: true;");

    const routes = await generateTypes({
      routesDirs: [ROUTES],
      format: "routes",
    });
    expect(routes).toContain('path: "/api/users/{id}"');
  });

  test("a config path is accepted and has no effect", async () => {
    // On Deno it selects the import map for a subprocess. Bun resolves the
    // route files' imports itself.
    const plain = await generateTypes({ routesDirs: [ROUTES] });
    const withConfig = await generateTypes({
      routesDirs: [ROUTES],
      config: "deno.json",
    });
    expect(withConfig).toBe(plain);
  });

  test("writes the output file", async () => {
    const output = join(scratch, "api.ts");
    const content = await generateTypes({ routesDirs: [ROUTES], output });
    expect(await readFile(output, "utf8")).toBe(content);
  });

  test("OpenAPI spec", async () => {
    const spec = await generateOpenApiSpec({ routesDir: ROUTES, strict: true });
    expect(Object.keys(spec.paths ?? {}).sort()).toEqual([
      "/api/notes/{id}",
      "/api/users",
      "/api/users/{id}",
    ]);
    expect(spec.paths?.["/api/users/{id}"]?.get?.operationId).toBe(
      "usersRetrieve",
    );
  });

  test("protocol types from a module", async () => {
    const types = await generateProtocolTypesFromModule(
      join(import.meta.dir, "protocol.ts"),
    );
    expect(types).toContain("export type LoginRequest =");
    expect(types).toContain('StepOutput<string, "login", "token">');
  });
});

describe("protocol sessions under Bun", () => {
  test("variant-dependent availability and revocation", async () => {
    const session = createSession(
      oauth2AuthCodeProtocol,
      createMockExecutor(oauth2AuthCodeProtocol, {
        authorize: { type: "success", code: "c-1", state: "s" },
        exchange: {
          type: "success",
          access_token: "at",
          token_type: "Bearer",
          expires_in: 3600,
        },
      }),
    );

    const { session: s1 } = await session.execute("authorize", {
      response_type: "code",
      client_id: "app",
      state: "s",
    });
    const granted = s1.ready("exchange");
    expect(granted).toBeDefined();

    const { session: s2 } = await granted!.execute("exchange", {
      grant_type: "authorization_code",
      code: "c-1",
      client_id: "app",
      client_secret: "secret",
    });
    // The code is spent; no refresh token was issued.
    expect(s2.availableSteps()).toEqual(["authorize", "revoke"]);
  });
});

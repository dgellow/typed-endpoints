/**
 * Responses whose type depends on the request, end to end.
 *
 * Route files declare the dependency (`projection()`, `expansion()`); the
 * generator carries it into the client types; a call is typed by its own
 * arguments. The same calls run against a live server, so each compile-time
 * claim is checked against what the server returns.
 */

import { assertEquals } from "@std/assert";
import { createClient } from "@/client/index.ts";
import { generateTypes } from "@/tsgen/mod.ts";

import type { Api } from "./fixtures/dependent/api.generated.ts";
import { handler as usersHandler } from "./fixtures/dependent/routes/api/users.ts";
import { handler as userHandler } from "./fixtures/dependent/routes/api/users/[id].ts";

const ROUTES = "e2e_tests/fixtures/dependent/routes/api";
const GENERATED = "e2e_tests/fixtures/dependent/api.generated.ts";

// -----------------------------------------------------------------------------
// Type-level assertions
// -----------------------------------------------------------------------------

/** Each type is assignable to the other. */
type Equal<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
function assertType<_T extends true>(): void {}

type User = { id: string; name: string; email: string; age?: number };
type Team = { id: string; title: string };

// -----------------------------------------------------------------------------
// Server
// -----------------------------------------------------------------------------

function serve(): {
  client: ReturnType<typeof createClient<Api>>;
  close: () => Promise<void>;
} {
  const controller = new AbortController();
  const server = Deno.serve(
    { port: 0, signal: controller.signal, onListen: () => {} },
    (req) => {
      const url = new URL(req.url);
      const id = url.pathname.match(/^\/api\/users\/([^/]+)$/)?.[1];
      // deno-lint-ignore no-explicit-any
      const ctx = { req, url, params: id ? { id } : {} } as any;
      if (id) return userHandler.GET(ctx);
      if (url.pathname === "/api/users") return usersHandler.GET(ctx);
      return new Response("not found", { status: 404 });
    },
  );
  return {
    client: createClient<Api>(`http://localhost:${server.addr.port}`),
    close: async () => {
      controller.abort();
      await server.finished;
    },
  };
}

// =============================================================================
// Generation
// =============================================================================

Deno.test("the checked-in client types are what the generator produces", async () => {
  const generated = await generateTypes({
    routesDirs: [ROUTES],
    format: "client",
    clientImport: "@/client/index.ts",
  });

  if (Deno.args.includes("--update")) {
    await Deno.writeTextFile(GENERATED, generated);
  }
  assertEquals(
    await Deno.readTextFile(GENERATED),
    generated,
    `${GENERATED} is stale; run ./scripts/test --update`,
  );
});

Deno.test("generation in a subprocess gives the same client types", async () => {
  const generated = await generateTypes({
    routesDirs: [ROUTES],
    format: "client",
    clientImport: "@/client/index.ts",
    // With a config, route files are imported in a subprocess.
    config: "deno.json",
  });

  assertEquals(generated, await Deno.readTextFile(GENERATED));
});

Deno.test("the client import defaults to the package's client entry point", async () => {
  const generated = await generateTypes({
    routesDirs: [ROUTES],
    format: "client",
  });

  assertEquals(
    generated.includes(
      'import type { Dependent, Expansion, Projection } from "@dgellow/typed-endpoints/client";',
    ),
    true,
  );
});

Deno.test("the flat types format describes what holds for every request", async () => {
  const types = await generateTypes({ routesDirs: [ROUTES], format: "types" });

  // No helper types, no import: the fallback type.
  assertEquals(types.includes("Dependent<"), false);
  assertEquals(types.includes("import "), false);
  assertEquals(
    types.includes("export type UsersByIdResponse = { id: string;"),
    true,
  );
});

// =============================================================================
// Projection: ?fields=
// =============================================================================

Deno.test("projection: the response type has the requested fields", async () => {
  const { client, close } = serve();
  try {
    const page = await client.users.list({
      query: { fields: ["id", "name"] },
    });

    assertType<
      Equal<
        typeof page,
        { data: { id: string; name: string }[]; total: number }
      >
    >();
    // @ts-expect-error email was not requested
    void page.data[0].email;

    // The server returned what the type says.
    assertEquals(page, {
      data: [
        { id: "1", name: "Ada" },
        { id: "2", name: "Grace" },
        { id: "3", name: "Edsger" },
      ],
      total: 3,
    });
  } finally {
    await close();
  }
});

Deno.test("projection: without the parameter the response is complete", async () => {
  const { client, close } = serve();
  try {
    const all = await client.users.list();
    assertType<Equal<typeof all, { data: User[]; total: number }>>();
    assertEquals(all.data[0], {
      id: "1",
      name: "Ada",
      email: "ada@example.test",
      age: 36,
    });

    // Other query parameters do not change the response type.
    const two = await client.users.list({ query: { limit: 2 } });
    assertType<Equal<typeof two, { data: User[]; total: number }>>();
    assertEquals(two.data.length, 2);
  } finally {
    await close();
  }
});

Deno.test("projection: a list computed elsewhere gives optional fields", async () => {
  const { client, close } = serve();
  try {
    // The type of this list does not say which names it holds.
    const wanted: ("id" | "email")[] = ["email"];
    const page = await client.users.list({ query: { fields: wanted } });

    assertType<
      Equal<
        typeof page,
        { data: { id?: string; email?: string }[]; total: number }
      >
    >();
    assertEquals(page.data[0], { email: "ada@example.test" });

    // A tuple element typed as a union is one of several names.
    const second = "name" as "name" | "email";
    const mixed = await client.users.list({
      query: { fields: ["id", second] },
    });
    assertType<
      Equal<
        typeof mixed.data[number],
        { id: string; name?: string; email?: string }
      >
    >();
    assertEquals(mixed.data[0], { id: "1", name: "Ada" });
  } finally {
    await close();
  }
});

Deno.test("projection: an empty list is every field, as for the server", async () => {
  const { client, close } = serve();
  try {
    const page = await client.users.list({ query: { fields: [] } });

    assertType<Equal<typeof page, { data: User[]; total: number }>>();
    assertEquals(page.data[1], {
      id: "2",
      name: "Grace",
      email: "grace@example.test",
    });
  } finally {
    await close();
  }
});

Deno.test("projection: a field that does not exist is a compile error", () => {
  const { client, close } = serve();
  const call = () =>
    // @ts-expect-error "password" is not a field of User
    client.users.list({ query: { fields: ["id", "password"] } });
  void call;
  return close();
});

// =============================================================================
// Expansion: ?expand=
// =============================================================================

Deno.test("expansion: the response type has the requested relations", async () => {
  const { client, close } = serve();
  try {
    const user = await client.users.retrieve("2", {
      query: { expand: ["team"] },
    });

    assertType<Equal<typeof user, User & { team: Team }>>();
    // Not optional: the type says the team is there.
    assertEquals(user.team.title, "Compilers");
    // @ts-expect-error manager was not expanded
    void user.manager;

    const both = await client.users.retrieve("2", {
      query: { expand: ["team", "manager"] },
    });
    assertType<Equal<typeof both, User & { team: Team; manager: User }>>();
    assertEquals(both.manager.name, "Ada");
  } finally {
    await close();
  }
});

Deno.test("expansion: a list computed elsewhere gives optional relations", async () => {
  const { client, close } = serve();
  try {
    const wanted: ("team" | "manager")[] = ["manager"];
    const user = await client.users.retrieve("3", {
      query: { expand: wanted },
    });

    assertType<Equal<typeof user, User & { team?: Team; manager?: User }>>();
    assertEquals(user.team, undefined);
    assertEquals(user.manager?.name, "Ada");
  } finally {
    await close();
  }
});

Deno.test("expansion: without the parameter the response is the base object", async () => {
  const { client, close } = serve();
  try {
    const user = await client.users.retrieve("2");

    assertType<Equal<typeof user, User>>();
    // @ts-expect-error nothing was expanded
    void user.team;
    assertEquals(user, { id: "2", name: "Grace", email: "grace@example.test" });
  } finally {
    await close();
  }
});

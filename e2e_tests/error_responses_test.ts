/**
 * Error responses declared per status code, end to end.
 *
 * A route declares `responses: { 404: NotFound, 409: Conflict }`. The
 * generator writes those bodies into the client types and the statuses
 * into the route table. `method.result()` then returns a declared error as
 * a value typed by its status; a status the route does not declare stays
 * an exception. The same calls run against a live server.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { ClientError, createClient } from "@/client/index.ts";
import { generateTypes } from "@/tsgen/mod.ts";

import { type Api, routes } from "./fixtures/errors/api.generated.ts";
import { handler as item } from "./fixtures/errors/routes/api/items/[id].ts";

const ROUTES = "e2e_tests/fixtures/errors/routes/api";
const GENERATED = "e2e_tests/fixtures/errors/api.generated.ts";

/** Each type is assignable to the other. */
type Equal<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
function assertType<_T extends true>(): void {}

type Item = { id: string; title: string; version: number };
type NotFound = { error: "not_found"; id: string };
type Conflict = { error: "conflict"; current: number };

function serve(): {
  client: ReturnType<typeof createClient<Api>>;
  baseUrl: string;
  close: () => Promise<void>;
} {
  type Handler = (ctx: unknown) => Promise<Response>;
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    const url = new URL(req.url);
    const id = url.pathname.match(/^\/api\/items\/([^/]+)$/)?.[1];
    const handle = (item as Record<string, unknown>)[req.method] as
      | Handler
      | undefined;
    return id && handle
      ? handle({ req, url, params: { id } })
      : new Response("not found", { status: 404 });
  });
  const baseUrl = `http://localhost:${server.addr.port}`;
  return {
    client: createClient<Api>({ baseUrl, routes }),
    baseUrl,
    close: () => server.shutdown(),
  };
}

Deno.test("errors: the checked-in client types are what the generator produces", async () => {
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

  // The flat format names each declared error body.
  const types = await generateTypes({ routesDirs: [ROUTES], format: "types" });
  assertEquals(
    types.includes(
      'export type ItemsByIdPutError409 = { error: "conflict"; current: number; };',
    ),
    true,
  );
});

Deno.test("errors: result() returns the response or a declared error, typed by status", async () => {
  const { client, close } = serve();
  try {
    const found = await client.items.retrieve.result("a");
    assertType<
      Equal<
        typeof found,
        | { readonly ok: true; readonly status: number; readonly data: Item }
        | {
          readonly ok: false;
          readonly status: 404;
          readonly error: NotFound;
        }
      >
    >();
    assertEquals(found, {
      ok: true,
      status: 200,
      data: { id: "a", title: "First", version: 1 },
    });

    const missing = await client.items.retrieve.result("zzz");
    assertEquals(missing, {
      ok: false,
      status: 404,
      error: { error: "not_found", id: "zzz" },
    });
    if (!missing.ok) {
      // Narrowed by `ok`: the only declared status, and its body.
      assertType<Equal<typeof missing.status, 404>>();
      assertEquals(missing.error.id, "zzz");
    }
  } finally {
    await close();
  }
});

Deno.test("errors: several declared statuses are told apart by status", async () => {
  const { client, close } = serve();
  try {
    const stale = await client.items.update.result("a", {
      title: "Changed",
      version: 7,
    });
    assertType<
      Equal<
        typeof stale,
        | { readonly ok: true; readonly status: number; readonly data: Item }
        | {
          readonly ok: false;
          readonly status: 404;
          readonly error: NotFound;
        }
        | {
          readonly ok: false;
          readonly status: 409;
          readonly error: Conflict;
        }
      >
    >();

    if (stale.ok) throw new Error("expected a conflict");
    if (stale.status === 409) {
      // The body of a 409: the current version, to retry with.
      assertType<Equal<typeof stale.error, Conflict>>();
      const retried = await client.items.update.result("a", {
        title: "Changed",
        version: stale.error.current,
      });
      assertEquals(retried, {
        ok: true,
        status: 200,
        data: { id: "a", title: "Changed", version: 2 },
      });
    } else {
      assertType<Equal<typeof stale.error, NotFound>>();
      throw new Error("expected a conflict, got not found");
    }

    const missing = await client.items.update.result("zzz", {
      title: "x",
      version: 1,
    });
    assertEquals(missing, {
      ok: false,
      status: 404,
      error: { error: "not_found", id: "zzz" },
    });
  } finally {
    await close();
  }
});

Deno.test("errors: a status the endpoint does not declare is still an exception", async () => {
  const { client, close } = serve();
  try {
    const error = await assertRejects(
      () => client.items.update.result("a", { title: "x", version: 0 }),
      ClientError,
    );
    assertEquals(error.status, 418);
    assertEquals(error.body, { error: "teapot" });
  } finally {
    await close();
  }
});

Deno.test("errors: a plain call still rejects for a declared status", async () => {
  const { client, close } = serve();
  try {
    const error = await assertRejects(
      () => client.items.retrieve("zzz"),
      ClientError,
    );
    assertEquals(error.status, 404);
    assertEquals(error.body, { error: "not_found", id: "zzz" });

    // And resolves with the response, as before.
    assertEquals((await client.items.retrieve("a")).id, "a");
  } finally {
    await close();
  }
});

Deno.test("errors: a response without a body is a result too", async () => {
  const { client, close } = serve();
  try {
    const gone = await client.items.delete.result("zzz");
    assertEquals(gone, {
      ok: false,
      status: 404,
      error: { error: "not_found", id: "zzz" },
    });

    const deleted = await client.items.delete.result("a");
    assertEquals(deleted, { ok: true, status: 204, data: undefined });
  } finally {
    await close();
  }
});

Deno.test("errors: without the route table nothing is known to be declared", async () => {
  const { baseUrl, close } = serve();
  try {
    const bare = createClient<Api>(baseUrl);
    const error = await assertRejects(
      () => bare.items.retrieve.result("zzz"),
      ClientError,
    );
    assertEquals(error.status, 404);
  } finally {
    await close();
  }
});

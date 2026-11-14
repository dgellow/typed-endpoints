/**
 * The typed client with a generated route table.
 *
 * The client used to derive a URL from property names:
 * `client.users.posts.list()` was `GET /api/users/posts`. Anything else
 * could be typed but not called: a parameter that is not the last segment,
 * a route outside `/api`, PUT next to PATCH, a catch-all, a resource
 * without an id. The generator now writes the routes as a value next to
 * `Api`, and the client reads method and URL from it.
 *
 * Client types are generated from the fixture routes and checked in; each
 * call runs against a live server.
 */

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { ClientError, createClient } from "@/client/index.ts";
import { fileRouter } from "@/integrations/fetch.ts";
import { generateTypes } from "@/tsgen/mod.ts";

import { type Api, routes } from "./fixtures/nested/api.generated.ts";

const ROUTES = "e2e_tests/fixtures/nested/routes";
const GENERATED = "e2e_tests/fixtures/nested/api.generated.ts";

/** Each type is assignable to the other. */
type Equal<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
function assertType<_T extends true>(): void {}

type Post = { id: string; userId: string; title: string };

async function serve() {
  const controller = new AbortController();
  const seen: string[] = [];
  const router = await fileRouter(ROUTES);
  const server = Deno.serve(
    { port: 0, signal: controller.signal, onListen: () => {} },
    (request) => {
      const url = new URL(request.url);
      seen.push(`${request.method} ${url.pathname}${url.search}`);
      return router(request);
    },
  );
  const baseUrl = `http://localhost:${server.addr.port}`;
  return {
    baseUrl,
    seen,
    client: createClient<Api>({ baseUrl, routes }),
    close: async () => {
      controller.abort();
      await server.finished;
    },
  };
}

Deno.test("the checked-in client types and route table are what the generator produces", async () => {
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

// =============================================================================
// Path parameters
// =============================================================================

Deno.test("a collection below a parameter takes the parameter in params", async () => {
  const { client, seen, close } = await serve();
  try {
    const posts = await client.users.posts.list({ params: { id: "7" } });

    assertType<Equal<typeof posts, Post[]>>();
    assertEquals(seen, ["GET /api/users/7/posts"]);
    assertEquals(posts.map((p) => p.userId), ["7", "7"]);

    // The query stays typed next to the params.
    const one = await client.users.posts.list({
      params: { id: "7" },
      query: { limit: 1 },
    });
    assertEquals(one.length, 1);
    assertEquals(seen.at(-1), "GET /api/users/7/posts?limit=1");

    const created = await client.users.posts.create({ title: "Hello" }, {
      params: { id: "7" },
    });
    assertEquals(created, { id: "new", userId: "7", title: "Hello" });
    assertEquals(seen.at(-1), "POST /api/users/7/posts");
  } finally {
    await close();
  }
});

Deno.test("params are required and typed", async () => {
  const { client, close } = await serve();
  try {
    // @ts-expect-error the path needs `id`
    const noParams = () => client.users.posts.list();
    const wrongName = () =>
      // @ts-expect-error `userId` is not a parameter of the path
      client.users.posts.list({ params: { userId: "7" } });
    const wrongType = () =>
      // @ts-expect-error the parameter is a string
      client.users.posts.list({ params: { id: 7 } });
    void [wrongName, wrongType];

    // Bypassing the types, the client names the missing parameter.
    assertThrows(
      noParams,
      TypeError,
      'users.posts.list: no value for the path parameter "id" of /api/users/{id}/posts',
    );
  } finally {
    await close();
  }
});

Deno.test("the trailing parameter is the id; the others are params", async () => {
  const { client, seen, close } = await serve();
  try {
    const post = await client.users.posts.retrieve("42", {
      params: { id: "7" },
    });

    assertType<Equal<typeof post, Post>>();
    assertEquals(post, { id: "42", userId: "7", title: "stored" });
    assertEquals(seen, ["GET /api/users/7/posts/42"]);

    // @ts-expect-error the parent parameter is still required
    void (() => client.users.posts.retrieve("42"));
    // The id is not passed twice.
    void (() =>
      client.users.posts.retrieve("42", {
        // @ts-expect-error `postId` is the id argument, not a param
        params: { id: "7", postId: "42" },
      }));

    const removed = await client.users.posts.delete("42", {
      params: { id: "7" },
    });
    assertEquals(removed, { deleted: "7/42" });
    assertEquals(seen.at(-1), "DELETE /api/users/7/posts/42");
  } finally {
    await close();
  }
});

Deno.test("values are encoded; a catch-all keeps its slashes", async () => {
  const { client, seen, close } = await serve();
  try {
    await client.users.posts.retrieve("a/b", { params: { id: "x y" } });
    assertEquals(seen.at(-1), "GET /api/users/x%20y/posts/a%2Fb");

    const file = await client.files.retrieve("docs/2026/q1 report.md");
    assertEquals(file, { path: "docs/2026/q1 report.md" });
    assertEquals(seen.at(-1), "GET /api/files/docs/2026/q1%20report.md");
  } finally {
    await close();
  }
});

// =============================================================================
// Methods
// =============================================================================

Deno.test("PUT next to PATCH: replace and update", async () => {
  const { client, seen, close } = await serve();
  try {
    const replaced = await client.users.posts.replace("42", { title: "New" }, {
      params: { id: "7" },
    });
    assertEquals(replaced.via, "PUT");
    assertEquals(seen.at(-1), "PUT /api/users/7/posts/42");

    const updated = await client.users.posts.update("42", {}, {
      params: { id: "7" },
    });
    assertEquals(updated.via, "PATCH");
    assertEquals(seen.at(-1), "PATCH /api/users/7/posts/42");

    // The bodies are typed per method: PUT needs the title.
    void (() =>
      // @ts-expect-error `title` is required for replace
      client.users.posts.replace("42", {}, { params: { id: "7" } }));
  } finally {
    await close();
  }
});

Deno.test("a DELETE with a declared body sends it, and the server validates it", async () => {
  const { client, baseUrl, seen, close } = await serve();
  try {
    // The path does not end with a parameter: the body is the first
    // argument, the parent's id goes in `params`.
    const out = await client.users.tags.delete({ tags: ["a", "c"] }, {
      params: { id: "42" },
    });
    assertType<Equal<typeof out, { remaining: string[] }>>();
    assertEquals(out, { remaining: ["b"] });
    assertEquals(seen.at(-1), "DELETE /api/users/42/tags");

    // @ts-expect-error the body is required
    void (() => client.users.tags.delete({ params: { id: "42" } }));
    void (() => {
      const params = { id: "42" };
      // @ts-expect-error `tags` is a list of strings
      client.users.tags.delete({ tags: "a" }, { params });
    });

    // A body the schema rejects is a 400 that names the field.
    const error = await assertRejects(
      () => client.users.tags.delete({ tags: [] }, { params: { id: "42" } }),
      ClientError,
    );
    assertEquals(error.status, 400);
    const body = error.body as {
      in: string;
      issues: { path: (string | number)[]; code: string }[];
    };
    assertEquals(body.in, "body");
    assertEquals(body.issues.map((issue) => [issue.path, issue.code]), [
      [["tags"], "too_small"],
    ]);

    // Sent without the client and without a body: refused as well.
    const bare = await fetch(`${baseUrl}/api/users/42/tags`, {
      method: "DELETE",
    });
    assertEquals(bare.status, 400);
    assertEquals((await bare.json()).in, "body");
  } finally {
    await close();
  }
});

Deno.test("a resource without an id takes none", async () => {
  const { client, seen, close } = await serve();
  try {
    // PUT alone is `update`; the path does not end with a parameter.
    const saved = await client.session.update({ theme: "dark" });
    assertEquals(saved, { theme: "dark" });
    assertEquals(seen.at(-1), "PUT /api/session");

    const out = await client.session.delete();
    assertEquals(out, { signedOut: true });
    assertEquals(seen.at(-1), "DELETE /api/session");

    // @ts-expect-error there is no id to pass
    void (() => client.session.delete("1"));
  } finally {
    await close();
  }
});

Deno.test("a route outside /api", async () => {
  const { client, seen, close } = await serve();
  try {
    assertEquals(await client.health.list(), { ok: true });
    assertEquals(seen, ["GET /health"]);
  } finally {
    await close();
  }
});

Deno.test("a subscription below a parameter", async () => {
  const { client, seen, close } = await serve();
  try {
    const events = [];
    for await (
      const event of client.users.events.subscribe({
        params: { id: "7" },
        reconnect: false,
      })
    ) {
      events.push(event);
    }

    assertEquals(events, [{ event: "seen", data: { userId: "7" } }]);
    assertEquals(seen, ["GET /api/users/7/events"]);

    // @ts-expect-error the path needs `id`
    void (() => client.users.events.subscribe());
  } finally {
    await close();
  }
});

// =============================================================================
// The table
// =============================================================================

Deno.test("a call that is not in the route table is refused before any request", async () => {
  const { baseUrl, seen, close } = await serve();
  try {
    const partial = createClient<Api>({
      baseUrl,
      routes: { "health.list": routes["health.list"] },
    });

    assertEquals(await partial.health.list(), { ok: true });
    assertThrows(
      () => partial.session.delete(),
      TypeError,
      "session.delete() is not in the route table passed to createClient()",
    );
    assertEquals(seen, ["GET /health"]);
  } finally {
    await close();
  }
});

Deno.test("without the route table, the URL comes from the property names", async () => {
  const { baseUrl, seen, close } = await serve();
  try {
    const legacy = createClient<Api>({ baseUrl });

    // What `basePath/resource[/id]` covers still works.
    assertEquals(await legacy.files.retrieve("a.md"), { path: "a.md" });
    assertEquals(seen.at(-1), "GET /api/files/a.md");

    // A route outside /api is derived wrongly: the reason for the table.
    await assertRejects(() => legacy.health.list(), ClientError);
    assertEquals(seen.at(-1), "GET /api/health");

    // `params` cannot be placed without a path template.
    assertThrows(
      () => legacy.users.posts.list({ params: { id: "7" } }),
      TypeError,
      "`params` needs the generated route table",
    );
  } finally {
    await close();
  }
});

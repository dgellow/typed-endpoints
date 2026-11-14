/**
 * Selections written as one string, end to end.
 *
 * The route declares `selection(Post, "select")`; the generator carries the
 * rule into the client types; the client parses the select string of each
 * call at the type level. The same calls run against a live server, so
 * each compile-time claim is checked against what the server returns.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { ClientError, createClient } from "@/client/index.ts";
import { generateTypes } from "@/tsgen/mod.ts";

import { type Api, routes } from "./fixtures/selection/api.generated.ts";
import { handler as postsHandler } from "./fixtures/selection/routes/api/posts.ts";

const ROUTES = "e2e_tests/fixtures/selection/routes/api";
const GENERATED = "e2e_tests/fixtures/selection/api.generated.ts";

/** Each type is assignable to the other. */
type Equal<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
function assertType<_T extends true>(): void {}

type Author = { id: string; name: string; email: string };
type Post = {
  id: string;
  title: string;
  body?: string;
  author: Author;
  reviewer: Author | null;
  tags: string[];
  comments: { id: string; text: string; by: Author }[];
};

function serve(): {
  client: ReturnType<typeof createClient<Api>>;
  seen: string[];
  close: () => Promise<void>;
} {
  const controller = new AbortController();
  const seen: string[] = [];
  const server = Deno.serve(
    { port: 0, signal: controller.signal, onListen: () => {} },
    (req) => {
      const url = new URL(req.url);
      seen.push(decodeURIComponent(url.search));
      // deno-lint-ignore no-explicit-any
      const ctx = { req, url, params: {} } as any;
      if (url.pathname === "/api/posts") return postsHandler.GET(ctx);
      return new Response("not found", { status: 404 });
    },
  );
  return {
    client: createClient<Api>({
      baseUrl: `http://localhost:${server.addr.port}`,
      routes,
    }),
    seen,
    close: async () => {
      controller.abort();
      await server.finished;
    },
  };
}

// =============================================================================
// Generation
// =============================================================================

Deno.test("selection: the checked-in client types are what the generator produces", async () => {
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
  assertEquals(
    generated.includes(
      'import type { Dependent, Selection } from "@/client/index.ts";',
    ),
    true,
  );
});

Deno.test("selection: generation in a subprocess gives the same client types", async () => {
  const generated = await generateTypes({
    routesDirs: [ROUTES],
    format: "client",
    clientImport: "@/client/index.ts",
    config: "deno.json",
  });
  assertEquals(generated, await Deno.readTextFile(GENERATED));
});

// =============================================================================
// Calls
// =============================================================================

Deno.test("selection: a nested select string types and shapes the response", async () => {
  const { client, seen, close } = serve();
  try {
    const page = await client.posts.list({
      query: { select: "id,author(name),comments(text,by(name))" },
    });

    assertType<
      Equal<
        typeof page,
        {
          data: {
            id: string;
            author: { name: string };
            comments: { text: string; by: { name: string } }[];
          }[];
          total: number;
        }
      >
    >();
    assertEquals(page.data[0], {
      id: "p1",
      author: { name: "Ada" },
      comments: [
        { text: "A classic.", by: { name: "Grace" } },
        { text: "Thanks!", by: { name: "Ada" } },
      ],
    });
    assertEquals(page.data[1], {
      id: "p2",
      author: { name: "Grace" },
      comments: [],
    });
    assertEquals(seen, ["?select=id,author(name),comments(text,by(name))"]);

    // What was not selected is not there, for the compiler and the server.
    // @ts-expect-error `title` was not selected
    void page.data[0].title;
    // @ts-expect-error `author.email` was not selected
    void page.data[0].author.email;
    assertEquals("title" in page.data[0], false);
  } finally {
    await close();
  }
});

Deno.test("selection: nullable and optional properties keep being so", async () => {
  const { client, close } = serve();
  try {
    const page = await client.posts.list({
      query: { select: "body, reviewer ( name ), tags" },
    });

    assertType<
      Equal<
        typeof page.data,
        { body?: string; reviewer: { name: string } | null; tags: string[] }[]
      >
    >();
    assertEquals(page.data, [
      {
        body: "The engine weaves algebraic patterns.",
        reviewer: { name: "Grace" },
        tags: ["history", "machines"],
      },
      { reviewer: null, tags: [] },
    ]);
  } finally {
    await close();
  }
});

Deno.test("selection: `*` is every property of its level", async () => {
  const { client, close } = serve();
  try {
    const page = await client.posts.list({
      query: { select: "*,author(name)", limit: 1 },
    });

    assertType<
      Equal<
        typeof page.data,
        (Omit<Post, "author"> & { author: { name: string } })[]
      >
    >();
    assertEquals(page.data[0].author, { name: "Ada" });
    assertEquals(page.data[0].title, "Notes on the Analytical Engine");
    assertEquals(page.data[0].comments.length, 2);
  } finally {
    await close();
  }
});

Deno.test("selection: without the parameter the response is complete", async () => {
  const { client, close } = serve();
  try {
    const page = await client.posts.list();
    assertType<Equal<typeof page, { data: Post[]; total: number }>>();
    assertEquals(page.data[1].title, "Compilers");

    const limited = await client.posts.list({ query: { limit: 1 } });
    assertType<Equal<typeof limited, { data: Post[]; total: number }>>();
    assertEquals(limited.data.length, 1);
  } finally {
    await close();
  }
});

Deno.test("selection: a string the types do not pin down may select anything", async () => {
  const { client, close } = serve();
  try {
    const chosen: string = ["id", "title"].join(",");
    const page = await client.posts.list({ query: { select: chosen } });

    // Every property is optional, at every depth.
    const first = page.data[0];
    assertType<Equal<typeof first.id, string | undefined>>();
    assertType<
      Equal<
        NonNullable<typeof first.author>["name"],
        string | undefined
      >
    >();
    assertEquals(first, {
      id: "p1",
      title: "Notes on the Analytical Engine",
    });
  } finally {
    await close();
  }
});

Deno.test("selection: one of several literal strings gives one of several types", async () => {
  const { client, close } = serve();
  try {
    const brief = Math.random() < 2;
    const page = await client.posts.list({
      query: { select: brief ? "id" : "title,author(name)" },
    });

    assertType<
      Equal<
        typeof page.data,
        ({ id: string } | { title: string; author: { name: string } })[]
      >
    >();
    assertEquals(page.data, [{ id: "p1" }, { id: "p2" }]);

    const calls = () => {
      client.posts.list({
        // @ts-expect-error one of the two strings names an unknown field
        query: { select: brief ? "id" : "nope" },
      });
    };
    void calls;
  } finally {
    await close();
  }
});

Deno.test("selection: a select string that does not fit is a compile error", () => {
  const { client, close } = serve();
  const calls = () => {
    // @ts-expect-error "nope" is not a field
    client.posts.list({ query: { select: "id,nope" } });
    // @ts-expect-error "author.age" is not a field
    client.posts.list({ query: { select: "id,author(age)" } });
    // @ts-expect-error "comments.by.phone" is not a field
    client.posts.list({ query: { select: "comments(by(phone))" } });
    // @ts-expect-error "title" has no fields to select
    client.posts.list({ query: { select: "title(length)" } });
    // @ts-expect-error "tags" has no fields to select
    client.posts.list({ query: { select: "tags(x)" } });
    // @ts-expect-error missing ")"
    client.posts.list({ query: { select: "id,author(name" } });
    // @ts-expect-error expected a field name
    client.posts.list({ query: { select: "id,,title" } });
    // @ts-expect-error unexpected ")"
    client.posts.list({ query: { select: "id)" } });

    // Next to another option, the error is still on the select string.
    client.posts.list({
      // @ts-expect-error "nope" is not a field
      query: { select: "nope", limit: 1 },
    });
  };
  void calls;
  return close();
});

Deno.test("selection: the server refuses what the types refuse", async () => {
  const { client, close } = serve();
  try {
    // Past the types: a string that is not a literal.
    for (
      const [select, reason] of [
        ["id,nope", '"nope" is not a field'],
        ["author(age)", '"author.age" is not a field'],
        ["title(length)", '"title" has no fields to select'],
        ["id,author(name", 'missing ")" after "author("'],
        ["id,,title", "expected a field name"],
      ]
    ) {
      const error = await assertRejects(
        () => client.posts.list({ query: { select: select as string } }),
        ClientError,
      );
      assertEquals(error.status, 400);
      // The reason is in the validation error, as the types word it.
      const text = JSON.stringify(error.body).replaceAll('\\"', '"');
      assertEquals(text.includes(reason), true, `${reason}: ${text}`);
    }
  } finally {
    await close();
  }
});

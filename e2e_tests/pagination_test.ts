/**
 * Pagination, end to end.
 *
 * Each route is built with a pagination helper and answers with the
 * helper's `page()` builder. The generator writes the pagination metadata
 * into the route table, and the client iterates: `list.pages()` and
 * `list.items()` ask for the next page the way the endpoint's style says.
 * One endpoint per style, against a live server.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { createClient } from "@/client/index.ts";
import { generateTypes } from "@/tsgen/mod.ts";

import { type Api, routes } from "./fixtures/pagination/api.generated.ts";
import { ITEMS } from "./fixtures/pagination/data.ts";
import { handler as events } from "./fixtures/pagination/routes/api/events.ts";
import { handler as orders } from "./fixtures/pagination/routes/api/orders.ts";
import { handler as products } from "./fixtures/pagination/routes/api/products.ts";
import { handler as repos } from "./fixtures/pagination/routes/api/repos.ts";
import { handler as users } from "./fixtures/pagination/routes/api/users.ts";

const ROUTES = "e2e_tests/fixtures/pagination/routes/api";
const GENERATED = "e2e_tests/fixtures/pagination/api.generated.ts";

/** Each type is assignable to the other. */
type Equal<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
function assertType<_T extends true>(): void {}

type Item = { id: string; name: string };
const NAMES = ITEMS.map((item) => item.name);

function serve(): {
  client: ReturnType<typeof createClient<Api>>;
  /** Path and query of every request, in order. */
  seen: string[];
  close: () => Promise<void>;
} {
  type Handler = (ctx: unknown) => Promise<Response>;
  const table: Record<string, { GET: unknown }> = {
    "/api/users": users,
    "/api/events": events,
    "/api/orders": orders,
    "/api/products": products,
    "/api/repos": repos,
  };
  const seen: string[] = [];
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    const url = new URL(req.url);
    seen.push(url.pathname + decodeURIComponent(url.search));
    const handler = table[url.pathname]?.GET as Handler | undefined;
    return handler
      ? handler({ req, url, params: {} })
      : new Response("not found", { status: 404 });
  });
  return {
    client: createClient<Api>({
      baseUrl: `http://localhost:${server.addr.port}`,
      routes,
    }),
    seen,
    close: () => server.shutdown(),
  };
}

/** Everything an async iterable yields. */
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const all: T[] = [];
  for await (const value of source) all.push(value);
  return all;
}

// =============================================================================
// Generation
// =============================================================================

Deno.test("pagination: the checked-in client types are what the generator produces", async () => {
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
// One endpoint per style
// =============================================================================

Deno.test("pagination: cursor style", async () => {
  const { client, seen, close } = serve();
  try {
    const items = await collect(client.users.list.items());
    assertType<Equal<typeof items, Item[]>>();
    assertEquals(items, ITEMS);
    // Each cursor is the one the page before returned.
    assertEquals(seen, [
      "/api/users",
      "/api/users?cursor=3",
      "/api/users?cursor=6",
    ]);

    const pages = await collect(client.users.list.pages());
    assertType<
      Equal<typeof pages, { data: Item[]; nextCursor?: string }[]>
    >();
    assertEquals(pages.map((page) => page.data.length), [3, 3, 1]);
    assertEquals(pages.map((page) => page.nextCursor), ["3", "6", undefined]);
  } finally {
    await close();
  }
});

Deno.test("pagination: cursor-id style", async () => {
  const { client, seen, close } = serve();
  try {
    const items = await collect(client.events.list.items());
    assertType<Equal<typeof items, Item[]>>();
    assertEquals(items, ITEMS);
    // Without a limit in the query the client cannot tell a short page
    // from a full one: it asks until a page comes back empty.
    assertEquals(seen, [
      "/api/events",
      "/api/events?after=i3",
      "/api/events?after=i6",
      "/api/events?after=i7",
    ]);

    // With a limit, a short page is known to be the last.
    seen.length = 0;
    await collect(client.events.list.items({ query: { limit: 3 } }));
    assertEquals(seen, [
      "/api/events?limit=3",
      "/api/events?limit=3&after=i3",
      "/api/events?limit=3&after=i6",
    ]);
  } finally {
    await close();
  }
});

Deno.test("pagination: offset style", async () => {
  const { client, seen, close } = serve();
  try {
    const items = await collect(client.orders.list.items());
    assertType<Equal<typeof items, Item[]>>();
    assertEquals(items, ITEMS);
    // The total says when to stop: no request for an empty page.
    assertEquals(seen, [
      "/api/orders",
      "/api/orders?offset=3",
      "/api/orders?offset=6",
    ]);

    // From an offset onwards, with another page size.
    seen.length = 0;
    const tail = await collect(
      client.orders.list.items({ query: { offset: 4, limit: 2 } }),
    );
    assertEquals(tail.map((item) => item.name), ["eel", "fox", "gnu"]);
    assertEquals(seen, [
      "/api/orders?offset=4&limit=2",
      "/api/orders?offset=6&limit=2",
    ]);
  } finally {
    await close();
  }
});

Deno.test("pagination: page-number style", async () => {
  const { client, seen, close } = serve();
  try {
    const pages = await collect(client.products.list.pages());
    assertType<
      Equal<typeof pages, { items: Item[]; pages: number; currency: string }[]>
    >();
    assertEquals(pages.map((page) => page.items.length), [3, 3, 1]);
    // The extra field the route declared is on every page.
    assertEquals(pages.every((page) => page.currency === "EUR"), true);
    // The page count says when to stop.
    assertEquals(seen, [
      "/api/products",
      "/api/products?page=2",
      "/api/products?page=3",
    ]);

    seen.length = 0;
    const items = await collect(
      client.products.list.items({ query: { page: 2, perPage: 4 } }),
    );
    assertEquals(items.map((item) => item.name), ["eel", "fox", "gnu"]);
    assertEquals(seen, ["/api/products?page=2&perPage=4"]);
  } finally {
    await close();
  }
});

Deno.test("pagination: URL style, with nested fields", async () => {
  const { client, seen, close } = serve();
  try {
    const items = await collect(client.repos.list.items());
    assertType<Equal<typeof items, Item[]>>();
    assertEquals(items, ITEMS);
    // The client follows the URL the response names.
    assertEquals(seen, [
      "/api/repos",
      "/api/repos?page=2",
      "/api/repos?page=3",
    ]);

    const pages = await collect(client.repos.list.pages());
    assertEquals(pages.map((page) => page.links), [
      { next: "/api/repos?page=2" },
      { next: "/api/repos?page=3", prev: "/api/repos?page=1" },
      { prev: "/api/repos?page=2" },
    ]);
  } finally {
    await close();
  }
});

// =============================================================================
// Together with the rest of the client
// =============================================================================

Deno.test("pagination: items are typed by the request, as a single page is", async () => {
  const { client, seen, close } = serve();
  try {
    const names = await collect(
      client.users.list.items({ query: { fields: ["name"], limit: 5 } }),
    );
    assertType<Equal<typeof names, { name: string }[]>>();
    assertEquals(names, NAMES.map((name) => ({ name })));
    // The projection travels with every page.
    assertEquals(seen, [
      "/api/users?fields=name&limit=5",
      "/api/users?fields=name&limit=5&cursor=5",
    ]);

    const call = () =>
      // @ts-expect-error "password" is not a field
      client.users.list.items({ query: { fields: ["password"] } });
    void call;
  } finally {
    await close();
  }
});

Deno.test("pagination: pages are requested as they are consumed", async () => {
  const { client, seen, close } = serve();
  try {
    for await (const item of client.orders.list.items()) {
      if (item.name === "bee") break;
    }
    // Leaving the loop on the first page: the second was never asked for.
    assertEquals(seen, ["/api/orders"]);

    // The call itself is still one page.
    const first = await client.orders.list();
    assertEquals(first.items.length, 3);
    assertEquals(first.total, 7);
  } finally {
    await close();
  }
});

Deno.test("pagination: an endpoint that is not paginated has nothing to iterate", async () => {
  const { client, close } = serve();
  try {
    const unpaged = createClient<Api>({
      baseUrl: "http://localhost:1",
      routes: { "orders.list": { method: "GET", path: "/api/orders" } },
    });
    await assertRejects(
      () => collect(unpaged.orders.list.items()),
      TypeError,
      "orders.list is not paginated",
    );

    const withoutRoutes = createClient<Api>("http://localhost:1");
    await assertRejects(
      () => collect(withoutRoutes.orders.list.pages()),
      TypeError,
      "paging needs the generated route table",
    );
    void client;
  } finally {
    await close();
  }
});

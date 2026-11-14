/**
 * E2E: a plan run over HTTP.
 *
 * The steps are derived from endpoint definitions (`fromEndpoint`), the
 * endpoints are served by a real HTTP server, and the plan is run through
 * the HTTP executor. One expression describes the whole interaction:
 *
 *   login >> (logged in ? listItems* : nothing)
 *
 * - `listItems` forwards the token of a successful login, so it has a plan
 *   only on the side of a branch that knows the login succeeded
 * - cursor pagination is a repetition: the request for page N+1 is built
 *   from the response to page N, and the number of pages is not known when
 *   the plan is written
 */

import { assertEquals, assertRejects } from "@std/assert";
import { z } from "zod";

import { createApiHandlers, endpoint } from "../src/integrations/fresh.ts";
import { cursor } from "../src/pagination/index.ts";
import {
  branch,
  createHttpExecutor,
  fromEndpoint,
  fromEndpointMapped,
  fromStep,
  InvalidRequestError,
  type PlanOf,
  protocol,
  repeat,
  runPlan,
  sequence,
} from "../src/protocol/index.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
function assertType<_T extends true>(): void {}

// -----------------------------------------------------------------------------
// Endpoints
// -----------------------------------------------------------------------------

const Item = z.object({ id: z.number(), name: z.string() });
const ITEMS = ["ant", "bee", "cat", "dog", "eel"].map((name, index) => ({
  id: index + 1,
  name,
}));

// routes/api/session.ts
const sessionHandler = createApiHandlers({
  POST: endpoint({
    body: z.strictObject({ user: z.string(), password: z.string() }),
    response: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), token: z.string() }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ]),
    public: true,
    handler: (_ctx, { body }) =>
      body.password === "secret"
        ? { ok: true as const, token: `token-of-${body.user}` }
        : { ok: false as const, error: "wrong password" },
  }),
});

// routes/api/items.ts
const itemsHandler = createApiHandlers({
  GET: endpoint({
    ...cursor.paginated({
      item: Item,
      defaultLimit: 2,
      extraQuery: { token: z.string() },
    }),
    public: true,
    handler: (_ctx, { query }) => {
      if (query.token !== "token-of-ada") {
        return Response.json({ error: "forbidden" }, { status: 403 });
      }
      const start = query.cursor ? Number(query.cursor) : 0;
      const end = start + query.limit;
      return {
        items: ITEMS.slice(start, end),
        ...(end < ITEMS.length && { cursor: String(end) }),
      };
    },
  }),
});

// -----------------------------------------------------------------------------
// Steps, from the endpoints
// -----------------------------------------------------------------------------

const login = fromEndpoint(sessionHandler, "POST", { name: "login" });

const listItems = fromEndpointMapped(itemsHandler, "GET", {
  name: "listItems",
  dependsOn: "login",
  // `token` exists on the success variant of the login response only.
  requestMapping: { token: fromStep("login", "token") },
});

const routes = {
  login: { method: "POST", path: "/api/session" },
  listItems: { method: "GET", path: "/api/items" },
} as const;

// The HTTP executor reads each step's route and field locations here.
const itemsProtocol = protocol({
  name: "Items",
  initial: "login",
  steps: { login, listItems },
});

const pages = repeat(listItems);
const browse = sequence(
  login,
  branch(login, (prev) => prev.ok, { then: pages, else: sequence() }),
);

type LoggedIn = Extract<z.infer<typeof login.response>, { ok: true }>;
/** The plan of the pages, where the login is known to have succeeded. */
type Pages = PlanOf<typeof pages, { readonly login: LoggedIn }>;

/** One page after the other, until the server sends no cursor. */
function everyPage(token: string, from?: string): Pages {
  return {
    next: { token, limit: 2, ...(from && { cursor: from }) },
    rest: (page) => page.cursor ? everyPage(token, page.cursor) : undefined,
  };
}

function plan(password: string): PlanOf<typeof browse> {
  return {
    first: { user: "ada", password },
    rest: () => ({
      ifTrue: (session) => everyPage(session.token),
      ifFalse: () => undefined,
    }),
  };
}

// -----------------------------------------------------------------------------
// Server
// -----------------------------------------------------------------------------

function startServer(): {
  readonly baseUrl: string;
  readonly seen: string[];
  readonly close: () => Promise<void>;
} {
  type Handler = (ctx: unknown) => Promise<Response>;
  const table: Record<string, Record<string, unknown>> = {
    "/api/session": sessionHandler,
    "/api/items": itemsHandler,
  };
  const seen: string[] = [];

  const server = Deno.serve({ port: 0, onListen: () => {} }, async (req) => {
    const url = new URL(req.url);
    seen.push(`${req.method} ${url.pathname}${url.search}`);
    const handler = table[url.pathname]?.[req.method] as Handler | undefined;
    if (!handler) return new Response("Not Found", { status: 404 });
    return await handler({ req, params: {} });
  });

  return {
    baseUrl: `http://localhost:${server.addr.port}`,
    seen,
    close: () => server.shutdown(),
  };
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

Deno.test("E2E plan: login, then every page of a cursor-paginated endpoint", async () => {
  const server = startServer();
  try {
    const executor = createHttpExecutor(itemsProtocol, {
      baseUrl: server.baseUrl,
      routes,
    });

    const [session, listing] = await runPlan(browse, plan("secret"), executor);

    assertEquals(session, { ok: true, token: "token-of-ada" });
    if (!listing.holds) throw new Error("expected the login to succeed");
    // The result of the repetition is the list of pages.
    assertType<
      Equal<
        typeof listing.result,
        { items: { id: number; name: string }[]; cursor?: string }[]
      >
    >();
    assertEquals(listing.result.length, 3);
    assertEquals(
      listing.result.flatMap((page) => page.items.map((item) => item.name)),
      ["ant", "bee", "cat", "dog", "eel"],
    );

    // Each cursor the client sent is the one the server returned before.
    assertEquals(server.seen, [
      "POST /api/session",
      "GET /api/items?limit=2&token=token-of-ada",
      "GET /api/items?cursor=2&limit=2&token=token-of-ada",
      "GET /api/items?cursor=4&limit=2&token=token-of-ada",
    ]);
  } finally {
    await server.close();
  }
});

Deno.test("E2E plan: a failed login takes the other side", async () => {
  const server = startServer();
  try {
    const executor = createHttpExecutor(itemsProtocol, {
      baseUrl: server.baseUrl,
      routes,
    });

    const [session, listing] = await runPlan(browse, plan("guess"), executor);

    assertEquals(session, { ok: false, error: "wrong password" });
    assertEquals(listing, { holds: false, result: [] });
    assertEquals(server.seen, ["POST /api/session"]);
  } finally {
    await server.close();
  }
});

Deno.test("E2E plan: a token other than the one the login returned is not sent", async () => {
  const server = startServer();
  try {
    const executor = createHttpExecutor(itemsProtocol, {
      baseUrl: server.baseUrl,
      routes,
    });

    const forged: PlanOf<typeof browse> = {
      first: { user: "ada", password: "secret" },
      rest: () => ({
        ifTrue: () => everyPage("token-of-eve"),
        ifFalse: () => undefined,
      }),
    };
    const error = await assertRejects(
      () => runPlan(browse, forged, executor),
      InvalidRequestError,
    );
    assertEquals(error.step, "listItems");
    // The request was refused before it left the client.
    assertEquals(server.seen, ["POST /api/session"]);
  } finally {
    await server.close();
  }
});

Deno.test("E2E plan: listing without a branch on the login has no plan", () => {
  const unchecked = sequence(login, pages);
  const never = false as boolean;
  if (never) {
    runPlan(unchecked, {
      first: { user: "ada", password: "secret" },
      rest: () => ({
        // @ts-expect-error: the login is not known to have a `token`
        next: { token: "token-of-ada", limit: 2 },
        rest: () => undefined,
      }),
    }, createHttpExecutor(itemsProtocol, { baseUrl: "", routes }));
  }
});

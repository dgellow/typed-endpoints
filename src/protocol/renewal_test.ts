/**
 * Renewal: a response that takes the place of an earlier step's response.
 *
 * A dependent step reads the latest response of the one step it depends
 * on. Tokens and cursors move on: the second refresh has to send the token
 * the first refresh returned, and page three is asked for with the cursor
 * of page two. `renewing()` declares it.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { z } from "zod";

import { createSession, present, type StepExecutor } from "./client.ts";
import {
  branch,
  dependentStep,
  protocol,
  renewing,
  repeat,
  sequence,
  step,
  validateProtocol,
} from "./dsl.ts";
import { InvalidRequestError, InvalidResponseError } from "./errors.ts";
import { oauth2AuthCodeProtocol } from "./oauth.ts";
import { type After, type PlanOf, runPlan } from "./plan.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
function assertType<_T extends true>(): void {}

// -----------------------------------------------------------------------------
// OAuth: refresh tokens that rotate
// -----------------------------------------------------------------------------

/** A token endpoint whose refresh tokens rotate, or not. */
function tokenServer(
  options: { rotate: boolean; omitRefreshToken?: boolean },
): StepExecutor & { readonly refreshed: string[] } {
  let generation = 1;
  const refreshed: string[] = [];
  return {
    refreshed,
    // deno-lint-ignore no-explicit-any
    execute(name: string, request: any) {
      const current = options.rotate ? `rt-${generation}` : "rt-1";
      switch (name) {
        case "authorize":
          return Promise.resolve({
            type: "success",
            code: "c",
            state: request.state,
          });
        case "exchange":
          return Promise.resolve({
            type: "success",
            access_token: "at-1",
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: "rt-1",
          });
        case "refresh": {
          refreshed.push(request.refresh_token);
          if (request.refresh_token !== current) {
            return Promise.resolve({ type: "error", error: "invalid_grant" });
          }
          generation++;
          return Promise.resolve({
            type: "success",
            access_token: `at-${generation}`,
            token_type: "Bearer",
            expires_in: 3600,
            ...(!options.omitRefreshToken && {
              refresh_token: options.rotate ? `rt-${generation}` : "rt-1",
            }),
          });
        }
        default:
          return Promise.resolve({ revoked: true });
      }
    },
  };
}

/** A session that has authorized and exchanged the code. */
async function exchanged(executor: StepExecutor) {
  const start = createSession(oauth2AuthCodeProtocol, executor);
  const { session: authorized } = await start.execute("authorize", {
    response_type: "code",
    client_id: "client",
    state: "s",
  });
  const granted = authorized.ready("exchange");
  assert(granted);
  const { session } = await granted.execute("exchange", {
    grant_type: "authorization_code",
    code: "c",
    client_id: "client",
    client_secret: "secret",
  });
  return session;
}

const refreshWith = (refresh_token: string) => ({
  grant_type: "refresh_token" as const,
  refresh_token,
  client_id: "client",
});

Deno.test("renewal: the second refresh sends the token the first one returned", async () => {
  const server = tokenServer({ rotate: true });
  const session = await exchanged(server);

  const first = session.ready("refresh");
  assert(first);
  const { response, session: afterFirst } = await first.execute(
    "refresh",
    refreshWith("rt-1"),
  );
  assertEquals(response.type, "success");

  // The refresh token of the exchange is spent on the server; the session
  // refuses to send it again.
  const second = afterFirst.ready("refresh");
  assert(second);
  await assertRejects(
    () => second.execute("refresh", refreshWith("rt-1")),
    InvalidRequestError,
  );
  const { response: again } = await second.execute(
    "refresh",
    refreshWith("rt-2"),
  );
  assertEquals(again.type, "success");

  // Nothing the server would refuse was sent.
  assertEquals(server.refreshed, ["rt-1", "rt-2"]);
});

Deno.test("renewal: revoke names the current tokens", async () => {
  const session = await exchanged(tokenServer({ rotate: true }));
  const live = session.ready("refresh");
  assert(live);
  const { session: refreshed } = await live.execute(
    "refresh",
    refreshWith("rt-1"),
  );

  const revocable = refreshed.ready("revoke");
  assert(revocable);
  // The access token of the exchange is no longer one of the grant's.
  await assertRejects(
    () => revocable.execute("revoke", { token: "at-1", client_id: "client" }),
    InvalidRequestError,
  );
  const { response } = await revocable.execute("revoke", {
    token: "at-2",
    client_id: "client",
  });
  assertEquals(response, { revoked: true });
});

Deno.test("renewal: a refresh response without a refresh token keeps the old one", async () => {
  const server = tokenServer({ rotate: false, omitRefreshToken: true });
  const session = await exchanged(server);
  const live = session.ready("refresh");
  assert(live);
  const { response, session: refreshed } = await live.execute(
    "refresh",
    refreshWith("rt-1"),
  );
  assertEquals("refresh_token" in response, false);

  // RFC 6749, section 6: no new refresh token means the old one stands.
  const again = refreshed.ready("refresh");
  assert(again);
  const { response: second } = await again.execute(
    "refresh",
    refreshWith("rt-1"),
  );
  assertEquals(second.type, "success");
});

Deno.test("renewal: an error response renews nothing", async () => {
  // The server expects another token than the one it issued: every refresh
  // fails.
  const failing: StepExecutor = {
    execute: (name, request, context) =>
      name === "refresh"
        ? Promise.resolve({ type: "error", error: "invalid_request" })
        : tokenServer({ rotate: false }).execute(name, request, context),
  };
  const session = await exchanged(failing);
  const live = session.ready("refresh");
  assert(live);
  const { response, session: after } = await live.execute(
    "refresh",
    refreshWith("rt-1"),
  );
  assertEquals(response.type, "error");

  // The tokens of the exchange still count: the refresh can be tried again.
  assertEquals(after.canExecute("refresh"), true);
  assertEquals(after.ready("refresh") !== undefined, true);
});

Deno.test("renewal: what was known about the renewed step is known anew", async () => {
  const session = await exchanged(tokenServer({ rotate: true }));
  const live = session.ready("refresh");
  assert(live);
  const { session: refreshed } = await live.execute(
    "refresh",
    refreshWith("rt-1"),
  );

  // Before the refresh the session knew the exchange had a refresh token.
  // The response that took its place may not have one.
  const direct = () =>
    // @ts-expect-error `refresh` needs a refresh token to be known again
    refreshed.execute("refresh", refreshWith("rt-2"));
  void direct;

  // It is still known to be a success: `revoke` asks for no more.
  const revoke = () =>
    refreshed.execute("revoke", { token: "at-2", client_id: "client" });
  void revoke;
});

// -----------------------------------------------------------------------------
// Pagination: every page is the latest page
// -----------------------------------------------------------------------------

const Page = z.object({
  items: z.array(z.string()),
  cursor: z.string().optional(),
});
type Page = z.infer<typeof Page>;

const firstPage = step({
  name: "firstPage",
  request: z.object({ limit: z.number() }),
  response: Page,
});

const nextPage = renewing(
  dependentStep({
    name: "nextPage",
    dependsOn: firstPage,
    // The latest page has a cursor.
    when: present("cursor"),
    request: (page) => z.object({ cursor: z.literal(page.cursor) }),
    response: Page,
  }),
  firstPage,
);

const listing = protocol({
  name: "Listing",
  initial: "firstPage",
  steps: { firstPage, nextPage },
});

/** Serves `total` items, `limit` per page; the cursor is an offset. */
function pages(total: number): StepExecutor & { readonly cursors: string[] } {
  const all = Array.from({ length: total }, (_, i) => `item-${i}`);
  const cursors: string[] = [];
  let limit = 2;
  return {
    cursors,
    // deno-lint-ignore no-explicit-any
    execute(name: string, request: any) {
      if (name === "firstPage") limit = request.limit;
      else cursors.push(request.cursor);
      const start = name === "firstPage" ? 0 : Number(request.cursor);
      const end = start + limit;
      return Promise.resolve({
        items: all.slice(start, end),
        ...(end < total && { cursor: String(end) }),
      });
    },
  };
}

Deno.test("renewal: a session pages through a listing", async () => {
  const server = pages(5);
  const { response: one, session: s1 } = await createSession(listing, server)
    .execute("firstPage", { limit: 2 });

  // Available while the latest page has a cursor. `one.cursor` and, after
  // it, `two.cursor` are that cursor: each `nextPage` is the latest page.
  const more = s1.ready("nextPage");
  assert(more);
  const { response: two, session: s2 } = await more.execute("nextPage", {
    cursor: one.cursor!,
  });

  const evenMore = s2.ready("nextPage");
  assert(evenMore);
  const { response: three, session: s3 } = await evenMore.execute("nextPage", {
    cursor: two.cursor!,
  });

  // The last page has no cursor: there is no next page.
  assertEquals(s3.ready("nextPage"), undefined);
  assertEquals(s3.canExecute("nextPage"), false);

  assertEquals(
    [...one.items, ...two.items, ...three.items],
    ["item-0", "item-1", "item-2", "item-3", "item-4"],
  );
  assertEquals(server.cursors, ["2", "4"]);
});

Deno.test("renewal: a stale cursor is not sent", async () => {
  const server = pages(5);
  const { session } = await createSession(listing, server)
    .execute("firstPage", { limit: 2 });
  const second = session.ready("nextPage");
  assert(second);
  const { session: afterSecond } = await second.execute("nextPage", {
    cursor: "2",
  });

  const third = afterSecond.ready("nextPage");
  assert(third);
  await assertRejects(
    () => third.execute("nextPage", { cursor: "2" }),
    InvalidRequestError,
  );
  assertEquals(server.cursors, ["2"]);
});

Deno.test("renewal: a plan pages with a branch on the latest page", async () => {
  // firstPage >> (has a cursor ? nextPage : nothing)*
  const browse = sequence(
    firstPage,
    repeat(
      branch(firstPage, present("cursor"), {
        then: nextPage,
        else: sequence(),
      }),
    ),
  );

  type Loop = Awaited<ReturnType<PlanOf<typeof browse>["rest"]>>;
  const loop: Loop = {
    next: {
      // `page` is the latest page, known to have a cursor.
      ifTrue: (page) => ({ cursor: page.cursor }),
      ifFalse: () => undefined,
    },
    // Stop after the turn that found no cursor.
    rest: (turn) => turn.holds ? loop : undefined,
  };

  const server = pages(7);
  const [first, turns] = await runPlan(browse, {
    first: { limit: 3 },
    rest: () => loop,
  }, server);

  const items = [
    ...first.items,
    ...turns.flatMap((turn) => turn.holds ? turn.result.items : []),
  ];
  assertEquals(items.length, 7);
  assertEquals(server.cursors, ["3", "6"]);
  assertEquals(turns.map((turn) => turn.holds), [true, true, false]);
});

Deno.test("renewal: what a plan knows after a renewing step", () => {
  // After `nextPage`, `firstPage` is known by the type of the new page.
  type Known = After<typeof nextPage, { readonly firstPage: Page }>;
  assertType<Equal<Known["firstPage"], Page>>();
  assertType<Equal<Known["nextPage"], Page>>();

  // A renewal that applies to some responses only: either the response
  // that was there, or the replacement.
  const poll = step({
    name: "poll",
    request: z.object({}),
    response: z.object({ done: z.boolean(), value: z.number().optional() }),
  });
  const result = step({
    name: "result",
    request: z.object({}),
    response: z.object({ value: z.number() }),
  });
  const maybe = renewing(
    poll,
    result,
    (response) =>
      response.value === undefined ? undefined : { value: response.value },
  );
  type AfterPoll = After<
    typeof maybe,
    { readonly result: { value: 1 } }
  >;
  assertType<Equal<AfterPoll["result"], { value: 1 } | { value: number }>>();
  // Not known before, and not certainly renewed: still not known.
  type Fresh = After<typeof maybe>;
  assertType<Equal<keyof Fresh, "poll">>();
});

// -----------------------------------------------------------------------------
// What renewing() rejects
// -----------------------------------------------------------------------------

Deno.test("renewal: the replacement has to be a response of the renewed step", async () => {
  const source = step({
    name: "source",
    request: z.object({}),
    response: z.object({ token: z.string() }),
  });
  const other = step({
    name: "other",
    request: z.object({}),
    response: z.object({ count: z.number() }),
  });

  const never = false as boolean;
  if (never) {
    // @ts-expect-error `{ count }` is not a response of `source`
    renewing(other, source);
    // @ts-expect-error the replacement lacks `token`
    renewing(other, source, (response) => ({ nope: response.count }));
  }

  // Past the types, the replacement is parsed like any response.
  const lying = renewing(
    other,
    source,
    // deno-lint-ignore no-explicit-any
    ((response: { count: number }) => ({ token: response.count })) as any,
  );
  const proto = protocol({
    name: "Lying",
    initial: "source",
    steps: { source, other: lying },
  });
  const error = await assertRejects(
    () =>
      createSession(proto, {
        execute: () => Promise.resolve({ count: 1 }),
      }).execute("other", {}),
    InvalidResponseError,
    'cannot renew "source"',
  );
  assertEquals(error.step, "other");
});

Deno.test("renewal: the renewed step has to be in the protocol", () => {
  const outside = step({
    name: "outside",
    request: z.object({}),
    response: Page,
  });
  const stray = renewing(
    step({ name: "stray", request: z.object({}), response: Page }),
    outside,
  );

  const never = false as boolean;
  if (never) {
    protocol({
      name: "Stray",
      initial: "stray",
      // @ts-expect-error `outside` is not a step of this protocol
      steps: { stray },
    });
  }

  const unchecked = {
    __kind: "protocol",
    name: "Stray",
    initial: "stray",
    steps: { stray },
  } as const;
  assertEquals(validateProtocol(unchecked).errors, [
    'Step "stray" renews "outside" which doesn\'t exist',
  ]);
});

/**
 * Variant-dependent availability.
 *
 * Whether a step can follow another often depends on which response came
 * back: `exchange` follows `authorize` only when the user granted access.
 * These tests pin both halves: what the compiler rejects (`@ts-expect-error`;
 * an unused directive is a failing test) and what the session refuses at
 * runtime when the types are bypassed.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { z } from "zod";

import {
  type AvailableSteps,
  createMockExecutor,
  createSession,
  type HasPath,
  present,
} from "./client.ts";
import { dependentStep, mappedStep, protocol, step } from "./dsl.ts";
import { StepRefusedError } from "./errors.ts";
import { fromStep } from "./mapping.ts";

// -----------------------------------------------------------------------------
// Type-level assertions
// -----------------------------------------------------------------------------

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
function assertType<_T extends true>(): void {}

// -----------------------------------------------------------------------------
// A protocol with a branching response
// -----------------------------------------------------------------------------

const authorize = step({
  name: "authorize",
  request: z.object({ client_id: z.string() }),
  response: z.discriminatedUnion("type", [
    z.object({ type: z.literal("success"), code: z.string() }),
    z.object({ type: z.literal("error"), error: z.string() }),
  ]),
});

const exchange = dependentStep({
  name: "exchange",
  // The step object, not its name: `prev` is typed from its response.
  dependsOn: authorize,
  // A plain predicate. TypeScript infers `prev is { type: "success"; ... }`.
  when: (prev) => prev.type === "success",
  // `prev` is the success variant here: `prev.code` needs no check.
  request: (prev) =>
    z.object({ code: z.literal(prev.code), client_secret: z.string() }),
  response: z.object({
    access_token: z.string(),
    refresh_token: z.string().optional(),
  }),
});

const reportDenial = dependentStep({
  name: "reportDenial",
  dependsOn: authorize,
  when: (prev) => prev.type === "error",
  request: (prev) => z.object({ reason: z.literal(prev.error) }),
  response: z.object({ logged: z.boolean() }),
});

// Forwards a field the response may not have.
const refresh = mappedStep({
  name: "refresh",
  dependsOn: "exchange",
  requestMapping: { refresh_token: fromStep("exchange", "refresh_token") },
  requestSchema: z.object({ refresh_token: z.string() }),
  response: z.object({ access_token: z.string() }),
});

// Forwards a field only one variant has.
const audit = mappedStep({
  name: "audit",
  dependsOn: "authorize",
  requestMapping: { code: fromStep("authorize", "code") },
  requestSchema: z.object({ code: z.string() }),
  response: z.object({ ok: z.boolean() }),
});

const oauth = protocol({
  name: "OAuth",
  initial: "authorize",
  steps: { authorize, exchange, reportDenial, refresh, audit },
});

type Steps = typeof oauth.steps;

function sessionAnswering(
  authorizeResponse: z.input<typeof authorize.response>,
  exchangeResponse: z.input<typeof exchange.response> = { access_token: "at" },
) {
  return createSession(
    oauth,
    createMockExecutor(oauth, {
      authorize: authorizeResponse,
      exchange: exchangeResponse,
      reportDenial: { logged: true },
      refresh: { access_token: "at2" },
      audit: { ok: true },
    }),
  );
}

const granted = { type: "success", code: "c-1" } as const;
const denied = { type: "error", error: "access_denied" } as const;

// =============================================================================
// Definition
// =============================================================================

Deno.test("dependentStep by reference infers prev and narrows it with when", () => {
  // The narrowed variant is part of the step's type.
  assertType<
    Equal<
      Parameters<typeof exchange.request>[0],
      { type: "success"; code: string }
    >
  >();
  assertType<
    Equal<
      Parameters<typeof reportDenial.request>[0],
      { type: "error"; error: string }
    >
  >();
  // The dependency is recorded by name.
  assertEquals(exchange.dependsOn, "authorize");
  assertType<Equal<typeof exchange.dependsOn, "authorize">>();
});

Deno.test("dependentStep by reference without when receives the whole response", () => {
  const next = dependentStep({
    name: "next",
    dependsOn: authorize,
    request: (prev) => {
      // @ts-expect-error `code` exists on one variant only
      void prev.code;
      return z.object({ kind: z.literal(prev.type) });
    },
    response: z.object({}),
  });

  assertType<
    Equal<
      Parameters<typeof next.request>[0],
      z.output<typeof authorize.response>
    >
  >();
  assertEquals(next.when, undefined);
});

Deno.test("protocol rejects a prev annotation that no response of the dependency satisfies", () => {
  const login = step({
    name: "login",
    request: z.object({}),
    response: z.object({ session: z.string() }),
  });

  protocol({
    name: "WrongAnnotation",
    initial: "login",
    steps: {
      login,
      // @ts-expect-error the response of "login" has no `token`
      profile: dependentStep({
        name: "profile",
        dependsOn: "login",
        request: (prev: { token: string }) =>
          z.object({ token: z.literal(prev.token) }),
        response: z.object({}),
      }),
    },
  });

  // A structural supertype of the response and a narrowing of it both pass.
  protocol({
    name: "RightAnnotations",
    initial: "login",
    steps: {
      login,
      authorize,
      profile: dependentStep({
        name: "profile",
        dependsOn: "login",
        request: (prev: { session: string }) =>
          z.object({ session: z.literal(prev.session) }),
        response: z.object({}),
      }),
      exchange: dependentStep({
        name: "exchange",
        dependsOn: "authorize",
        request: (prev: { type: "success"; code: string }) =>
          z.object({ code: z.literal(prev.code) }),
        response: z.object({}),
      }),
    },
  });
});

// =============================================================================
// Compile time: availability follows what is known about the response
// =============================================================================

Deno.test("a step that needs a variant is unavailable until the response is narrowed", async () => {
  const { session } = await sessionAnswering(granted).execute("authorize", {
    client_id: "app",
  });

  // After authorize, nothing is known about which variant came back.
  assertType<
    Equal<AvailableSteps<Steps, "authorize">, "authorize">
  >();

  const tooEarly = () =>
    // @ts-expect-error "exchange" needs the success variant
    session.execute("exchange", { code: "c-1", client_secret: "s" });
  void tooEarly;

  const ok = session.narrow("authorize", (r) => r.type === "success");
  if (!ok) throw new Error("expected the success variant");

  // The success variant makes exchange and audit available, not reportDenial.
  const { response } = await ok.execute("exchange", {
    code: "c-1",
    client_secret: "s",
  });
  assertEquals(response.access_token, "at");
  assertEquals((await ok.execute("audit", { code: "c-1" })).response.ok, true);

  // @ts-expect-error "reportDenial" needs the error variant
  const refused = ok.execute("reportDenial", { reason: "access_denied" });
  await assertRejects(() => refused, StepRefusedError, "`when` guard is false");
});

Deno.test("narrow returns undefined when the response is another variant", async () => {
  const { session } = await sessionAnswering(denied).execute("authorize", {
    client_id: "app",
  });

  assertEquals(
    session.narrow("authorize", (r) => r.type === "success"),
    undefined,
  );

  const no = session.narrow("authorize", (r) => r.type === "error");
  if (!no) throw new Error("expected the error variant");
  const { response } = await no.execute("reportDenial", {
    reason: "access_denied",
  });
  assertEquals(response.logged, true);
});

Deno.test("an optional field has to be established before it is forwarded", async () => {
  const start = await sessionAnswering(granted, {
    access_token: "at",
    refresh_token: "rt",
  }).execute("authorize", { client_id: "app" });
  const ok = start.session.narrow("authorize", (r) => r.type === "success")!;
  const { session } = await ok.execute("exchange", {
    code: "c-1",
    client_secret: "s",
  });

  const unproven = () =>
    // @ts-expect-error refresh_token is optional in the "exchange" response
    session.execute("refresh", { refresh_token: "rt" });
  void unproven;

  const withRefresh = session.narrow("exchange", present("refresh_token"));
  if (!withRefresh) throw new Error("expected a refresh token");
  const { response } = await withRefresh.execute("refresh", {
    refresh_token: "rt",
  });
  assertEquals(response.access_token, "at2");
});

Deno.test("present() fails when the value is missing", async () => {
  const start = await sessionAnswering(granted).execute("authorize", {
    client_id: "app",
  });
  const ok = start.session.narrow("authorize", (r) => r.type === "success")!;
  const { session } = await ok.execute("exchange", {
    code: "c-1",
    client_secret: "s",
  });

  assertEquals(session.narrow("exchange", present("refresh_token")), undefined);
});

Deno.test("executing a step again forgets what was known about its response", async () => {
  const start = await sessionAnswering(granted).execute("authorize", {
    client_id: "app",
  });
  const ok = start.session.narrow("authorize", (r) => r.type === "success")!;

  // A second authorize may come back as the other variant.
  const again = await ok.execute("authorize", { client_id: "app" });

  const stale = () =>
    // @ts-expect-error the new response of "authorize" is not narrowed
    again.session.execute("exchange", { code: "", client_secret: "" });
  void stale;

  // What was known about other steps is kept.
  const exchanged = await ok.execute("exchange", {
    code: "c-1",
    client_secret: "s",
  });
  const stillNarrow = await exchanged.session.execute("audit", { code: "c-1" });
  assertEquals(stillNarrow.response.ok, true);
});

// =============================================================================
// ready(): the step's own conditions as evidence
// =============================================================================

Deno.test("ready() establishes what a dependent step needs", async () => {
  const { session } = await sessionAnswering(granted).execute("authorize", {
    client_id: "app",
  });

  // The guard of reportDenial does not hold for this response.
  assertEquals(session.ready("reportDenial"), undefined);

  const forExchange = session.ready("exchange");
  if (!forExchange) throw new Error("expected exchange to be ready");
  const { response } = await forExchange.execute("exchange", {
    code: "c-1",
    client_secret: "s",
  });
  assertEquals(response.access_token, "at");

  // What ready() proved for exchange is what audit needs as well.
  assertEquals((await forExchange.execute("audit", { code: "c-1" })).response, {
    ok: true,
  });
});

Deno.test("ready() establishes the values a mapped step forwards", async () => {
  const start = await sessionAnswering(granted, {
    access_token: "at",
    refresh_token: "rt",
  }).execute("authorize", { client_id: "app" });
  const { session } = await start.session.ready("exchange")!.execute(
    "exchange",
    { code: "c-1", client_secret: "s" },
  );

  const forRefresh = session.ready("refresh");
  if (!forRefresh) throw new Error("expected refresh to be ready");
  const { response } = await forRefresh.execute("refresh", {
    refresh_token: "rt",
  });
  assertEquals(response.access_token, "at2");
});

Deno.test("ready() is undefined before the dependency has run", () => {
  const start = sessionAnswering(granted);

  assertEquals(start.ready("exchange"), undefined);
  assertEquals(start.ready("audit"), undefined);
  // A step without dependencies is always ready.
  assertEquals(start.ready("authorize"), start);
});

// =============================================================================
// Runtime: the same rules when the types are bypassed
// =============================================================================

Deno.test("the when guard refuses the step at runtime", async () => {
  const { session } = await sessionAnswering(denied).execute("authorize", {
    client_id: "app",
  });
  // deno-lint-ignore no-explicit-any
  const untyped = session as any;

  const error = await assertRejects(
    () => untyped.execute("exchange", { code: "c-1", client_secret: "s" }),
    StepRefusedError,
  );
  assertEquals(error.step, "exchange");
  assertEquals(error.because, "authorize");
});

Deno.test("canExecute and availableSteps follow the variant that came back", async () => {
  const start = sessionAnswering(granted);
  assertEquals(start.availableSteps(), ["authorize"]);

  const afterGrant = (await start.execute("authorize", { client_id: "app" }))
    .session;
  assertEquals(afterGrant.availableSteps(), ["authorize", "exchange", "audit"]);
  assertEquals(afterGrant.canExecute("reportDenial"), false);

  const afterDenial = (await sessionAnswering(denied).execute("authorize", {
    client_id: "app",
  })).session;
  assertEquals(afterDenial.availableSteps(), ["authorize", "reportDenial"]);

  // refresh needs a refresh_token in the response of exchange.
  const ok = afterGrant.narrow("authorize", (r) => r.type === "success")!;
  const without = (await ok.execute("exchange", {
    code: "c-1",
    client_secret: "s",
  })).session;
  assertEquals(without.canExecute("refresh"), false);
});

// =============================================================================
// HasPath
// =============================================================================

Deno.test("HasPath: which types guarantee a value at a path", () => {
  type T = {
    a: string;
    b?: string;
    c: string | undefined;
    d: string | null;
    nested: { x: number; y?: number };
    maybe?: { x: number };
    list: { id: string }[];
    open: Record<string, number>;
  };

  assertType<Equal<HasPath<T, "a">, true>>();
  assertType<Equal<HasPath<T, "b">, false>>();
  assertType<Equal<HasPath<T, "c">, false>>();
  // null is a value; only a missing value refuses a mapped step.
  assertType<Equal<HasPath<T, "d">, true>>();
  assertType<Equal<HasPath<T, "nested.x">, true>>();
  assertType<Equal<HasPath<T, "nested.y">, false>>();
  assertType<Equal<HasPath<T, "maybe.x">, false>>();
  assertType<Equal<HasPath<T, "missing">, false>>();
  assertType<Equal<HasPath<T, "a.length.x">, false>>();
  // Left to the runtime check: an index may be past the end, a record may
  // not have the key.
  assertType<Equal<HasPath<T, "list.0.id">, true>>();
  assertType<Equal<HasPath<T, "open.anything">, true>>();

  // A union guarantees a path only if every member does.
  type U = { type: "a"; code: string } | { type: "b"; error: string };
  assertType<Equal<HasPath<U, "type">, true>>();
  assertType<Equal<HasPath<U, "code">, false>>();
  assertType<Equal<HasPath<Extract<U, { type: "a" }>, "code">, true>>();

  // Types that say nothing are not a reason to refuse.
  // deno-lint-ignore no-explicit-any
  assertType<Equal<HasPath<any, "x.y">, true>>();
  assertType<Equal<HasPath<unknown, "x">, true>>();
  assertType<Equal<HasPath<T, string>, true>>();
  assertType<Equal<HasPath<never, "x">, false>>();
});

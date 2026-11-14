/**
 * Revocation and single use.
 *
 * A session's state can shrink: logging out ends what logging in started,
 * and an authorization code can be exchanged once. `revoking()` declares
 * it; the session type loses the revoked steps, and so do the responses
 * the session holds.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { z } from "zod";

import {
  type AvailableSteps,
  createMockExecutor,
  createSession,
} from "./client.ts";
import {
  dependentStep,
  protocol,
  revoking,
  step,
  validateProtocol,
} from "./dsl.ts";
import {
  InvalidRequestError,
  SessionSpentError,
  StepNotAvailableError,
} from "./errors.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
function assertType<_T extends true>(): void {}

// -----------------------------------------------------------------------------
// login -> profile* -> logout, where logout revokes login
// -----------------------------------------------------------------------------

const login = step({
  name: "login",
  request: z.object({ user: z.string() }),
  response: z.object({ token: z.string() }),
});

const profile = dependentStep({
  name: "profile",
  dependsOn: login,
  request: (prev) => z.object({ token: z.literal(prev.token) }),
  response: z.object({ name: z.string() }),
});

const logout = revoking(
  dependentStep({
    name: "logout",
    dependsOn: login,
    request: (prev) => z.object({ token: z.literal(prev.token) }),
    response: z.object({ ok: z.literal(true) }),
  }),
  ["login", "profile"],
);

const account = protocol({
  name: "Account",
  initial: "login",
  terminal: ["logout"],
  steps: { login, profile, logout },
});

type Steps = typeof account.steps;

function accountSession(options?: { singleUse?: boolean }) {
  return createSession(
    account,
    createMockExecutor(account, {
      login: { token: "t-1" },
      profile: { name: "Ada" },
      logout: { ok: true },
    }),
    options,
  );
}

// =============================================================================
// Revocation
// =============================================================================

Deno.test("revoking() records the revoked steps on the step", () => {
  assertEquals(logout.revokes, ["login", "profile"]);
  assertEquals(logout.name, "logout");
  assertEquals(logout.dependsOn, "login");
  assertType<Equal<typeof logout.revokes, readonly ("login" | "profile")[]>>();
});

Deno.test("a revoked step no longer counts as executed", async () => {
  const s1 = (await accountSession().execute("login", { user: "ada" })).session;
  const s2 = (await s1.execute("profile", { token: "t-1" })).session;
  assertType<
    Equal<
      AvailableSteps<Steps, "login" | "profile">,
      "login" | "profile" | "logout"
    >
  >();

  const { session: after } = await s2.execute("logout", { token: "t-1" });

  // Compile time: only logout remains in the session's state.
  assertType<Equal<keyof typeof after.responses, "logout">>();
  const again = () =>
    // @ts-expect-error login was revoked, so profile is not available
    after.execute("profile", { token: "t-1" });

  // Runtime: the responses are gone, and so is the availability.
  assertEquals(Object.keys(after.responses), ["logout"]);
  assertEquals(after.availableSteps(), ["login"]);
  assertEquals(after.canExecute("profile"), false);
  const error = await assertRejects(again, StepNotAvailableError);
  assertEquals(error.requires, "login");

  // The history is a log; it keeps what happened.
  assertEquals(after.history, ["login", "profile", "logout"]);
  assertEquals(after.isTerminal(), true);
});

Deno.test("a revoked step can run again and makes its dependents available again", async () => {
  const s1 = (await accountSession().execute("login", { user: "ada" })).session;
  const { session: out } = await s1.execute("logout", { token: "t-1" });

  const { session: back } = await out.execute("login", { user: "ada" });
  const { response } = await back.execute("profile", { token: "t-1" });
  assertEquals(response.name, "Ada");
});

Deno.test("a step that revokes its dependency can run once per run of that dependency", async () => {
  const authorize = step({
    name: "authorize",
    request: z.object({}),
    response: z.object({ code: z.string() }),
  });
  // RFC 6749, section 4.1.2: a code must not be used more than once.
  const exchange = revoking(
    dependentStep({
      name: "exchange",
      dependsOn: authorize,
      request: (prev) => z.object({ code: z.literal(prev.code) }),
      response: z.object({ access_token: z.string() }),
    }),
    ["authorize"],
  );
  const oauth = protocol({
    name: "OneShot",
    initial: "authorize",
    steps: { authorize, exchange },
  });
  const start = createSession(
    oauth,
    createMockExecutor(oauth, {
      authorize: { code: "c-1" },
      exchange: { access_token: "at" },
    }),
  );

  const s1 = (await start.execute("authorize", {})).session;
  const { session: s2, response } = await s1.execute("exchange", {
    code: "c-1",
  });
  assertEquals(response.access_token, "at");

  // The token is still there; the code is spent.
  assertEquals(s2.responses.exchange.access_token, "at");
  assertType<Equal<keyof typeof s2.responses, "exchange">>();
  const replay = () =>
    // @ts-expect-error authorize was consumed by the first exchange
    s2.execute("exchange", { code: "c-1" });
  await assertRejects(replay, StepNotAvailableError);

  // A new authorization allows a new exchange.
  const s3 = (await s2.execute("authorize", {})).session;
  assertEquals(
    (await s3.execute("exchange", { code: "c-1" })).response.access_token,
    "at",
  );
});

Deno.test("what was known about a revoked response is dropped", async () => {
  const s1 = (await accountSession().execute("login", { user: "ada" })).session;
  const narrowed = s1.narrow(
    "login",
    (r): r is { token: "t-1" } => r.token === "t-1",
  )!;
  assertType<Equal<typeof narrowed.responses.login.token, "t-1">>();

  const out = (await narrowed.execute("logout", { token: "t-1" })).session;
  const back = (await out.execute("login", { user: "ada" })).session;

  // The new login response is known by its schema type again.
  assertType<Equal<typeof back.responses.login.token, string>>();
});

Deno.test("protocol rejects revoking a step it does not have", () => {
  protocol({
    name: "Typo",
    initial: "login",
    steps: {
      login,
      // @ts-expect-error "logn" is not a step of this protocol
      logout: revoking(
        step({
          name: "logout",
          request: z.object({}),
          response: z.object({}),
        }),
        ["logn"],
      ),
    },
  });

  const untyped = {
    __kind: "protocol",
    name: "Typo",
    initial: "login",
    steps: {
      login,
      logout: revoking(
        step({ name: "logout", request: z.object({}), response: z.object({}) }),
        ["logn"],
      ),
    },
  } as unknown as Parameters<typeof validateProtocol>[0];
  assertEquals(validateProtocol(untyped).errors, [
    `Step "logout" revokes "logn" which doesn't exist`,
  ]);
});

// =============================================================================
// Single use
// =============================================================================

Deno.test("without singleUse, a session value from before a revocation still works", async () => {
  const s1 = (await accountSession().execute("login", { user: "ada" })).session;
  await s1.execute("logout", { token: "t-1" });

  // s1 is unchanged and typed as before: the types cannot retire it.
  const { response } = await s1.execute("profile", { token: "t-1" });
  assertEquals(response.name, "Ada");
});

Deno.test("singleUse: a session value executes one step", async () => {
  const start = accountSession({ singleUse: true });
  const s1 = (await start.execute("login", { user: "ada" })).session;
  await s1.execute("logout", { token: "t-1" });

  const error = await assertRejects(
    () => s1.execute("profile", { token: "t-1" }),
    SessionSpentError,
    'already used to execute "logout"',
  );
  assertEquals(error.step, "profile");
  assertEquals(error.spentBy, "logout");

  // The initial session is spent too.
  await assertRejects(
    () => start.execute("login", { user: "ada" }),
    SessionSpentError,
  );
});

Deno.test("singleUse: the returned session continues, and stays single-use", async () => {
  const s1 = (await accountSession({ singleUse: true }).execute("login", {
    user: "ada",
  })).session;
  const s2 = (await s1.execute("profile", { token: "t-1" })).session;
  const s3 = (await s2.execute("profile", { token: "t-1" })).session;

  assertEquals(s3.history, ["login", "profile", "profile"]);
  await assertRejects(
    () => s2.execute("logout", { token: "t-1" }),
    SessionSpentError,
  );
});

Deno.test("singleUse: a failed step does not spend the session", async () => {
  const s1 = (await accountSession({ singleUse: true }).execute("login", {
    user: "ada",
  })).session;

  await assertRejects(
    () => s1.execute("profile", { token: "wrong" }),
    InvalidRequestError,
  );

  // The same value can try again.
  const { response } = await s1.execute("profile", { token: "t-1" });
  assertEquals(response.name, "Ada");
});

Deno.test("singleUse: ready() and narrow() return the same value and do not spend it", async () => {
  const s1 = (await accountSession({ singleUse: true }).execute("login", {
    user: "ada",
  })).session;

  const ready = s1.ready("profile");
  const narrowed = s1.narrow("login", (r): r is { token: string } => !!r.token);
  assertEquals(ready === s1, true);
  assertEquals(narrowed === s1, true);

  assertEquals(
    (await ready!.execute("profile", { token: "t-1" })).response.name,
    "Ada",
  );
});

/**
 * Forwarded fields: what a mapped step takes from an earlier response,
 * the session fills in.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { z } from "zod";

import {
  completeRequest,
  createSession,
  type Forwarded,
  fromStep,
  InvalidRequestError,
  mappedStep,
  protocol,
  renewing,
  runPlan,
  sequence,
  step,
  type StepExecutor,
  type StepInput,
  StepRefusedError,
} from "./index.ts";

/** Each type is assignable to the other. */
type Equal<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;
function assertType<_T extends true>(): void {}

// =============================================================================
// A bank: login, refresh, transfer
// =============================================================================

const Session = z.object({
  token: z.string(),
  account: z.object({ id: z.string() }),
  note: z.string().optional(),
});

const login = step({
  name: "login",
  request: z.object({ user: z.string() }),
  response: Session,
});

// Every refresh gives a new token: its response takes the place of login's.
const refresh = renewing(
  step({ name: "refresh", request: z.object({}), response: Session }),
  login,
);

const transfer = mappedStep({
  name: "transfer",
  dependsOn: "login",
  requestMapping: {
    token: fromStep("login", "token"),
    from: fromStep("login", "account.id"),
  },
  requestSchema: z.object({
    token: z.string(),
    from: z.string(),
    to: z.string(),
    amount: z.number(),
  }),
  response: z.object({ id: z.string() }),
});

const annotate = mappedStep({
  name: "annotate",
  dependsOn: "login",
  requestMapping: { note: fromStep("login", "note") },
  requestSchema: z.object({ note: z.string() }),
  response: z.object({}),
});

const bank = protocol({
  name: "Bank",
  initial: "login",
  steps: { login, refresh, transfer, annotate },
});

/** An executor that hands out a new token per login and refresh. */
function server() {
  const calls: { step: string; request: unknown }[] = [];
  let tokens = 0;
  const executor: StepExecutor = {
    execute: <T>(name: string, request: unknown): Promise<T> => {
      calls.push({ step: name, request });
      const response = name === "transfer"
        ? { id: `tx-${calls.length}` }
        : name === "annotate"
        ? {}
        : { token: `t${++tokens}`, account: { id: "acc-1" } };
      return Promise.resolve(response as T);
    },
  };
  return { executor, calls, last: () => calls.at(-1)!.request };
}

// =============================================================================
// Types
// =============================================================================

Deno.test("forwarded: the forwarded fields of a mapped step are optional", () => {
  assertType<
    Equal<
      StepInput<typeof transfer>,
      { to: string; amount: number; token?: string; from?: string }
    >
  >();
  // A step whose every field is forwarded takes an empty request.
  assertType<Equal<StepInput<typeof annotate>, { note?: string }>>();
  // Steps that forward nothing are unchanged.
  assertType<Equal<StepInput<typeof login>, { user: string }>>();

  // Each member of a union keeps its own fields.
  assertType<
    Equal<
      Forwarded<{ kind: "a"; id: string } | { kind: "b"; n: number }, "id">,
      { kind: "a"; id?: string } | { kind: "b"; n: number }
    >
  >();
});

// =============================================================================
// Sessions
// =============================================================================

Deno.test("forwarded: a field left out is filled in from the earlier response", async () => {
  const bankServer = server();
  const start = createSession(bank, bankServer.executor);
  const { session } = await start.execute("login", { user: "ada" });

  await session.execute("transfer", { to: "acc-2", amount: 5 });
  assertEquals(bankServer.last(), {
    token: "t1",
    from: "acc-1",
    to: "acc-2",
    amount: 5,
  });

  // The fields that are not forwarded are still required.
  // @ts-expect-error `amount` is missing
  const incomplete = session.execute("transfer", { to: "acc-2" });
  await assertRejects(() => incomplete, InvalidRequestError);
});

Deno.test("forwarded: a field given with the forwarded value is accepted", async () => {
  const bankServer = server();
  const start = createSession(bank, bankServer.executor);
  const { session, response } = await start.execute("login", { user: "ada" });

  await session.execute("transfer", {
    token: response.token,
    to: "acc-2",
    amount: 5,
  });
  assertEquals(bankServer.last(), {
    token: "t1",
    from: "acc-1",
    to: "acc-2",
    amount: 5,
  });
});

Deno.test("forwarded: a field given with another value is rejected before the call", async () => {
  const bankServer = server();
  const start = createSession(bank, bankServer.executor);
  const { session } = await start.execute("login", { user: "ada" });
  const before = bankServer.calls.length;

  await assertRejects(
    () =>
      session.execute("transfer", {
        token: "someone-else",
        to: "acc-2",
        amount: 5,
      }),
    InvalidRequestError,
  );
  await assertRejects(
    () =>
      session.execute("transfer", { from: "acc-9", to: "acc-2", amount: 5 }),
    InvalidRequestError,
  );
  assertEquals(bankServer.calls.length, before);
});

Deno.test("forwarded: after a renewal the field is the renewed value, and the old one is refused", async () => {
  const bankServer = server();
  const start = createSession(bank, bankServer.executor);
  const loggedIn = await start.execute("login", { user: "ada" });
  const stale = loggedIn.response.token;
  const refreshed = await loggedIn.session.execute("refresh", {});

  // Left out, the token cannot be stale: there is nothing to restate.
  await refreshed.session.execute("transfer", { to: "acc-2", amount: 5 });
  assertEquals(
    (bankServer.last() as { token: string }).token,
    refreshed.response.token,
  );

  // Restated from before the refresh, it is refused.
  await assertRejects(
    () =>
      refreshed.session.execute("transfer", {
        token: stale,
        to: "acc-2",
        amount: 5,
      }),
    InvalidRequestError,
  );
});

Deno.test("forwarded: a field whose source has no value still refuses the step", async () => {
  // `note` is optional in the login response and absent here.
  const bankServer = server();
  const start = createSession(bank, bankServer.executor);
  const { session } = await start.execute("login", { user: "ada" });

  // The types ask for proof that the value is there, and there is none.
  assertEquals(session.ready("annotate"), undefined);

  // Past the types: nothing is filled in, and nothing made up is accepted.
  await assertRejects(
    // @ts-expect-error `note` is not known to have a value
    () => session.execute("annotate", {}),
    StepRefusedError,
  );
  await assertRejects(
    // @ts-expect-error `note` is not known to have a value
    () => session.execute("annotate", { note: "made up" }),
    StepRefusedError,
  );
});

Deno.test("forwarded: a step whose every field is forwarded takes an empty request", async () => {
  const calls: unknown[] = [];
  const executor: StepExecutor = {
    execute: <T>(name: string, request: unknown): Promise<T> => {
      calls.push(request);
      return Promise.resolve(
        (name === "login"
          ? { token: "t1", account: { id: "acc-1" }, note: "hello" }
          : {}) as T,
      );
    },
  };
  const start = createSession(bank, executor);
  const { session } = await start.execute("login", { user: "ada" });

  const ready = session.ready("annotate");
  if (!ready) throw new Error("the login response has a note");
  await ready.execute("annotate", {});
  assertEquals(calls.at(-1), { note: "hello" });
});

// =============================================================================
// Plans
// =============================================================================

Deno.test("forwarded: a plan leaves the forwarded fields out as well", async () => {
  const bankServer = server();
  const result = await runPlan(
    sequence(login, transfer),
    {
      first: { user: "ada" },
      rest: () => ({ to: "acc-2", amount: 7 }),
    },
    bankServer.executor,
  );

  assertEquals(result[1], { id: "tx-2" });
  assertEquals(bankServer.last(), {
    token: "t1",
    from: "acc-1",
    to: "acc-2",
    amount: 7,
  });
});

// =============================================================================
// completeRequest()
// =============================================================================

Deno.test("forwarded: completeRequest fills what is absent and keeps what is given", () => {
  const responses = { login: { token: "t1", account: { id: "acc-1" } } };

  assertEquals(completeRequest(transfer, { to: "x" }, responses), {
    to: "x",
    token: "t1",
    from: "acc-1",
  });
  // A field given, right or wrong, is kept for the schema to judge.
  assertEquals(
    completeRequest(transfer, { token: "other", from: undefined }, responses),
    { token: "other", from: "acc-1" },
  );
  // A source without a value fills nothing in.
  assertEquals(completeRequest(annotate, {}, responses), {});
  // Other steps and requests that are not objects are returned as they are.
  assertEquals(completeRequest(login, { user: "ada" }, {}), { user: "ada" });
  assertEquals(completeRequest(transfer, "text", responses), "text");
  assertEquals(completeRequest(transfer, [1], responses), [1]);
});

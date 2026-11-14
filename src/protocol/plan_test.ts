/**
 * Plans: running compositions.
 *
 * The request to a sequence is a request and a continuation; the request
 * to a repetition is a list built one response at a time. These tests run
 * André Videla's file session, `OPEN (READ | WRITE)* CLOSE`, and an OAuth
 * flow whose second half depends on which variant came back.
 */

import { assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
import { z } from "zod";

import { present, type StepExecutor } from "./client.ts";
import {
  branch,
  choice,
  dependentStep,
  mappedStep,
  parallel,
  repeat,
  repeat1,
  revoking,
  sequence,
  step,
} from "./dsl.ts";
import { fromStep } from "./mapping.ts";
import {
  InvalidRequestError,
  InvalidResponseError,
  StepNotAvailableError,
  StepRefusedError,
} from "./errors.ts";
import {
  type After,
  each,
  PlanError,
  type PlanOf,
  type ResultOf,
  runPlan,
} from "./plan.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
function assertType<_T extends true>(): void {}

// -----------------------------------------------------------------------------
// OPEN (READ | WRITE)* CLOSE
// -----------------------------------------------------------------------------

const open = step({
  name: "open",
  request: z.object({ path: z.string() }),
  response: z.object({ handle: z.number() }),
});

const read = step({
  name: "read",
  request: z.object({ handle: z.number() }),
  response: z.object({ data: z.string() }),
});

const write = step({
  name: "write",
  request: z.object({ handle: z.number(), data: z.string() }),
  response: z.object({ written: z.number() }),
});

const close = step({
  name: "close",
  request: z.object({ handle: z.number() }),
  response: z.object({ closed: z.literal(true) }),
});

const fileOperations = repeat(choice(read, write));
const fileSession = sequence(open, fileOperations, close);

/** A file system with one file per path and a log of what was asked. */
function fileSystem(): StepExecutor & {
  readonly files: Map<string, string>;
  readonly log: string[];
} {
  const files = new Map<string, string>();
  const handles = new Map<number, string>();
  const log: string[] = [];
  let nextHandle = 3;
  return {
    files,
    log,
    // deno-lint-ignore no-explicit-any
    execute(name: string, request: any) {
      log.push(name);
      switch (name) {
        case "open": {
          const handle = nextHandle++;
          handles.set(handle, request.path);
          if (!files.has(request.path)) files.set(request.path, "");
          return Promise.resolve({ handle });
        }
        case "read":
          return Promise.resolve({
            data: files.get(handles.get(request.handle)!)!,
          });
        case "write": {
          const path = handles.get(request.handle)!;
          files.set(path, files.get(path)! + request.data);
          return Promise.resolve({ written: request.data.length });
        }
        case "close":
          handles.delete(request.handle);
          return Promise.resolve({ closed: true });
        default:
          throw new Error(`unexpected step ${name}`);
      }
    },
  };
}

Deno.test("plan: the types of the file session", () => {
  type Session = typeof fileSession;

  assertType<
    Equal<
      ResultOf<Session>,
      [
        { handle: number },
        (
          | { readonly choice: "read"; readonly result: { data: string } }
          | { readonly choice: "write"; readonly result: { written: number } }
        )[],
        { closed: true },
      ]
    >
  >();

  // The plan of the whole is a request to `open` and a continuation.
  type Plan = PlanOf<Session>;
  assertType<Equal<Plan["first"], { path: string }>>();
  assertType<Equal<Parameters<Plan["rest"]>[0], { handle: number }>>();
});

Deno.test("plan: zero operations between open and close", async () => {
  const fs = fileSystem();

  const [opened, operations, closed] = await runPlan(fileSession, {
    first: { path: "empty.txt" },
    rest: (opened) => ({
      first: undefined,
      rest: () => ({ handle: opened.handle }),
    }),
  }, fs);

  assertEquals(opened, { handle: 3 });
  assertEquals(operations, []);
  assertEquals(closed, { closed: true });
  assertEquals(fs.log, ["open", "close"]);
});

Deno.test("plan: each() writes one line per item", async () => {
  const fs = fileSystem();
  const lines = ["one\n", "two\n", "three\n"];

  const [, operations] = await runPlan(fileSession, {
    first: { path: "notes.txt" },
    rest: ({ handle }) => ({
      first: each(lines, (data) => ({
        choose: "write",
        plan: { handle, data },
      })),
      rest: () => ({ handle }),
    }),
  }, fs);

  assertEquals(fs.files.get("notes.txt"), "one\ntwo\nthree\n");
  assertEquals(operations.map((op) => op.choice), ["write", "write", "write"]);
  assertEquals(fs.log, ["open", "write", "write", "write", "close"]);
});

Deno.test("plan: a repetition decides from each response", async () => {
  const fs = fileSystem();
  fs.files.set("counter.txt", "");

  // Write "x" and read back, until the file holds three of them. How many
  // operations run is not known when the plan is written.
  type Loop = PlanOf<typeof fileOperations>;
  const loop = (handle: number): Loop => ({
    next: { choose: "write", plan: { handle, data: "x" } },
    rest: () => ({
      next: { choose: "read", plan: { handle } },
      rest: (seen) =>
        seen.choice === "read" && seen.result.data.length < 3
          ? loop(handle)
          : undefined,
    }),
  });

  const [, operations] = await runPlan(fileSession, {
    first: { path: "counter.txt" },
    rest: ({ handle }) => ({
      first: loop(handle),
      rest: () => ({ handle }),
    }),
  }, fs);

  assertEquals(fs.files.get("counter.txt"), "xxx");
  assertEquals(
    operations.map((op) => op.choice),
    ["write", "read", "write", "read", "write", "read"],
  );
});

Deno.test("plan: requests and responses are validated", async () => {
  const fs = fileSystem();

  const badRequest = await assertRejects(
    () =>
      runPlan(fileSession, {
        first: { path: "a.txt" },
        rest: () => ({
          first: {
            next: {
              choose: "write",
              // The types allow any number; the runner parses it.
              plan: { handle: Number.NaN, data: "x" },
            },
            rest: () => undefined,
          },
          rest: () => ({ handle: 3 }),
        }),
      }, fs),
    InvalidRequestError,
  );
  assertEquals(badRequest.step, "write");
  // Nothing after the refused request ran.
  assertEquals(fs.log, ["open"]);

  const lying: StepExecutor = {
    execute: (name) =>
      Promise.resolve(name === "open" ? { handle: "three" } : {}),
  };
  let continued = false;
  const badResponse = await assertRejects(
    () =>
      runPlan(fileSession, {
        first: { path: "a.txt" },
        rest: ({ handle }) => {
          continued = true;
          return { first: undefined, rest: () => ({ handle }) };
        },
      }, lying),
    InvalidResponseError,
  );
  assertEquals(badResponse.step, "open");
  // A continuation never sees a response its schema rejects.
  assertEquals(continued, false);
});

Deno.test("plan: what the types reject", () => {
  const fs = fileSystem();
  const never = false as boolean;
  if (never) {
    // A sequence needs its continuation.
    // @ts-expect-error: `rest` is missing
    runPlan(fileSession, { first: { path: "a.txt" } }, fs);

    runPlan(fileSession, {
      first: { path: "a.txt" },
      rest: ({ handle }) => ({
        first: {
          // @ts-expect-error: `write` needs `data`
          next: {
            choose: "write",
            plan: { handle },
          },
          rest: () => undefined,
        },
        rest: () => ({ handle }),
      }),
    }, fs);

    runPlan(fileSession, {
      first: { path: "a.txt" },
      rest: ({ handle }) => ({
        first: {
          next: {
            // @ts-expect-error: not an option of the choice
            choose: "append",
            plan: { handle, data: "x" },
          },
          rest: () => undefined,
        },
        rest: () => ({ handle }),
      }),
    }, fs);

    runPlan(fileSession, {
      first: { path: "a.txt" },
      // @ts-expect-error: `open` returns no `fd`
      rest: ({ fd }) => ({
        first: undefined,
        rest: () => ({ handle: fd }),
      }),
    }, fs);

    runPlan(fileSession, {
      first: { path: "a.txt" },
      rest: () => ({
        first: undefined,
        // @ts-expect-error: `close` needs a handle
        rest: () => ({}),
      }),
    }, fs);
  }
});

// -----------------------------------------------------------------------------
// Bounds of a repetition
// -----------------------------------------------------------------------------

const ping = step({
  name: "ping",
  request: z.object({ n: z.number() }),
  response: z.object({ n: z.number() }),
});

/** The response of `ping`. */
type N = z.infer<typeof ping.response>;

const echo: StepExecutor = {
  execute: (_name, request) => Promise.resolve(request),
};

Deno.test("plan: a repetition keeps to min and max", async () => {
  const numbers = (count: number) =>
    each(Array.from({ length: count }, (_, n) => n), (n) => ({ n }));

  assertEquals(
    await runPlan(repeat(ping, { min: 1, max: 3 }), numbers(3), echo),
    [{ n: 0 }, { n: 1 }, { n: 2 }],
  );

  const tooFew = await assertRejects(
    () => runPlan(repeat1(ping), undefined, echo),
    PlanError,
    "requires at least 1",
  );
  assertEquals(tooFew.at, "repeat");

  let calls = 0;
  const counting: StepExecutor = {
    execute: (_name, request) => {
      calls++;
      return Promise.resolve(request);
    },
  };
  await assertRejects(
    () => runPlan(repeat(ping, { max: 2 }), numbers(5), counting),
    PlanError,
    "more than the 2 repetitions",
  );
  // The third request was never sent.
  assertEquals(calls, 2);
});

Deno.test("plan: a plan that never stops is cut off", async () => {
  type Forever = PlanOf<ReturnType<typeof repeat<typeof ping>>>;
  const forever = (n: number): Forever => ({
    next: { n },
    rest: () => forever(n + 1),
  });

  await assertRejects(
    () => runPlan(repeat(ping), forever(0), echo, { maxRepetitions: 50 }),
    PlanError,
    "stopped after 50 repetitions",
  );
});

Deno.test("plan: a continuation may be async, and may throw to stop", async () => {
  const twice = sequence(ping, ping);

  assertEquals(
    await runPlan(twice, {
      first: { n: 1 },
      rest: async ({ n }) => {
        await Promise.resolve();
        return { n: n + 1 };
      },
    }, echo),
    [{ n: 1 }, { n: 2 }],
  );

  let calls = 0;
  await assertRejects(
    () =>
      runPlan(twice, {
        first: { n: 1 },
        rest: () => {
          throw new RangeError("enough");
        },
      }, {
        execute: (_name, request) => {
          calls++;
          return Promise.resolve(request);
        },
      }),
    RangeError,
    "enough",
  );
  assertEquals(calls, 1);
});

Deno.test("plan: a plan returned from an async continuation is not a promise", async () => {
  // A plan with a member called `then` would be a thenable: `await` and
  // async functions would call it instead of passing it on. No plan type
  // has that member, so nested plans survive async continuations.
  const thrice = sequence(ping, ping, ping);
  type Plan = PlanOf<typeof thrice>;
  assertType<Equal<"then" extends keyof Plan ? true : false, false>>();
  assertType<
    Equal<
      "then" extends keyof Awaited<ReturnType<Plan["rest"]>> ? true : false,
      false
    >
  >();

  assertEquals(
    await runPlan(thrice, {
      first: { n: 1 },
      rest: async ({ n }) => {
        await Promise.resolve();
        return {
          first: { n: n * 2 },
          rest: async (second) => {
            await Promise.resolve();
            return { n: second.n * 2 };
          },
        };
      },
    }, echo),
    [{ n: 1 }, { n: 2 }, { n: 4 }],
  );
});

// -----------------------------------------------------------------------------
// What a plan knows: dependencies, variants, revocation
// -----------------------------------------------------------------------------

const AuthSuccess = z.object({ type: z.literal("success"), code: z.string() });
const AuthError = z.object({ type: z.literal("error"), reason: z.string() });
type Success = z.infer<typeof AuthSuccess>;
type Failure = z.infer<typeof AuthError>;

const authorize = step({
  name: "authorize",
  request: z.object({ client: z.string() }),
  response: z.discriminatedUnion("type", [AuthSuccess, AuthError]),
});

// Follows a successful authorization only, and spends it.
const exchange = revoking(
  dependentStep({
    name: "exchange",
    dependsOn: authorize,
    when: (prev) => prev.type === "success",
    request: (prev) => z.object({ code: z.literal(prev.code) }),
    response: z.object({
      token: z.string(),
      refresh_token: z.string().optional(),
    }),
  }),
  ["authorize"],
);

// Forwards a field the token response may not have.
const refresh = mappedStep({
  name: "refresh",
  dependsOn: "exchange",
  requestMapping: { refresh_token: fromStep("exchange", "refresh_token") },
  requestSchema: z.object({ refresh_token: z.string() }),
  response: z.object({ token: z.string() }),
});

const report = step({
  name: "report",
  request: z.object({ reason: z.string() }),
  response: z.object({ reported: z.literal(true) }),
});

const login = sequence(
  authorize,
  branch(authorize, (prev) => prev.type === "success", {
    then: exchange,
    else: report,
  }),
);

function authServer(
  outcome: "success" | "error",
  options: { readonly refreshToken?: string } = {},
): StepExecutor & { readonly log: string[] } {
  const log: string[] = [];
  return {
    log,
    // deno-lint-ignore no-explicit-any
    execute(name: string, request: any) {
      log.push(name);
      switch (name) {
        case "authorize":
          return Promise.resolve(
            outcome === "success"
              ? { type: "success", code: "c0de" }
              : { type: "error", reason: "denied" },
          );
        case "exchange":
          return Promise.resolve({
            token: `token-for-${request.code}`,
            ...(options.refreshToken &&
              { refresh_token: options.refreshToken }),
          });
        case "refresh":
          return Promise.resolve({ token: `via-${request.refresh_token}` });
        case "ping":
          return Promise.resolve(request);
        default:
          return Promise.resolve({ reported: true });
      }
    },
  };
}

// deno-lint-ignore no-explicit-any
const runUntyped = runPlan as (...args: any[]) => Promise<unknown>;

/** Whether a plan type is one no value has. */
type Uninhabited<T> = [T] extends [never] ? false
  : [T] extends [{ readonly "no plan exists": never }] ? true
  : false;

Deno.test("plan: a branch runs the side its predicate selects", async () => {
  const plan: PlanOf<typeof login> = {
    first: { client: "app" },
    rest: () => ({
      // `prev` is the success variant: `code` exists.
      ifTrue: (prev) => ({ code: prev.code }),
      // `prev` is the error variant: `reason` exists.
      ifFalse: (prev) => ({ reason: prev.reason }),
    }),
  };

  const granted = authServer("success");
  const [, afterSuccess] = await runPlan(login, plan, granted);
  assertEquals(afterSuccess, {
    holds: true,
    result: { token: "token-for-c0de" },
  });
  assertEquals(granted.log, ["authorize", "exchange"]);

  const denied = authServer("error");
  const [, afterError] = await runPlan(login, plan, denied);
  assertEquals(afterError, { holds: false, result: { reported: true } });
  assertEquals(denied.log, ["authorize", "report"]);

  if (!afterError.holds) {
    assertType<Equal<typeof afterError.result, { reported: true }>>();
  }
});

Deno.test("plan: the sides of a branch see their half of the response", () => {
  type Sides = Awaited<ReturnType<PlanOf<typeof login>["rest"]>>;
  assertType<Equal<Parameters<Sides["ifTrue"]>[0], Success>>();
  assertType<Equal<Parameters<Sides["ifFalse"]>[0], Failure>>();

  const never = false as boolean;
  if (never) {
    runPlan(login, {
      first: { client: "app" },
      rest: () => ({
        // @ts-expect-error: the success variant has no `reason`
        ifTrue: (prev) => ({ code: prev.reason }),
        // @ts-expect-error: the error variant has no `code`
        ifFalse: (prev) => ({ reason: prev.code }),
      }),
    }, authServer("success"));
  }
});

Deno.test("plan: a step has no plan before its dependency has run", () => {
  // Alone, and before `authorize`.
  assertType<Uninhabited<PlanOf<typeof exchange>>>();
  const reversed = sequence(exchange, authorize);
  assertType<Uninhabited<PlanOf<typeof reversed>["first"]>>();

  // After it, the step is ready on the side that knows the variant.
  type Sides = Awaited<ReturnType<PlanOf<typeof login>["rest"]>>;
  assertType<
    Equal<Awaited<ReturnType<Sides["ifTrue"]>>, { code: string }>
  >();

  const never = false as boolean;
  if (never) {
    // @ts-expect-error: no plan exists
    runPlan(exchange, { code: "c0de" }, authServer("success"));

    runPlan(reversed, {
      // @ts-expect-error: `exchange` runs before `authorize`
      first: { code: "c0de" },
      rest: () => ({ client: "app" }),
    }, authServer("success"));
  }
});

Deno.test("plan: a step that follows one variant needs a branch", () => {
  // `authorize` may have failed: `exchange` cannot follow it directly.
  const unchecked = sequence(authorize, exchange);
  type Rest = Awaited<ReturnType<PlanOf<typeof unchecked>["rest"]>>;
  assertType<Uninhabited<Rest>>();
  // The plan type says what is missing.
  assertType<Equal<Rest["it needs"], { readonly authorize: Success }>>();
  assertType<
    Equal<Rest["known here"]["authorize"], Success | Failure>
  >();

  const never = false as boolean;
  if (never) {
    runPlan(unchecked, {
      first: { client: "app" },
      // @ts-expect-error: `authorize` is not known to have succeeded
      rest: () => ({ code: "c0de" }),
    }, authServer("success"));
  }

  // On the wrong side of the branch it is not ready either.
  const wrongSide = sequence(
    authorize,
    branch(authorize, (prev) => prev.type === "success", {
      then: report,
      else: exchange,
    }),
  );
  type WrongSides = Awaited<ReturnType<PlanOf<typeof wrongSide>["rest"]>>;
  assertType<Uninhabited<Awaited<ReturnType<WrongSides["ifFalse"]>>>>();
});

Deno.test("plan: what a step revokes is not known after it", () => {
  // `exchange` spends the authorization: there is no second exchange.
  const twice = sequence(
    authorize,
    branch(authorize, (prev) => prev.type === "success", {
      then: sequence(exchange, exchange),
      else: report,
    }),
  );
  type Sides = Awaited<ReturnType<PlanOf<typeof twice>["rest"]>>;
  type Then = Awaited<ReturnType<Sides["ifTrue"]>>;
  assertType<Equal<Then["first"], { code: string }>>();
  assertType<Uninhabited<Awaited<ReturnType<Then["rest"]>>>>();

  // A repetition cannot spend what it does not renew: its second run
  // would have no authorization.
  const spending = sequence(
    authorize,
    branch(authorize, (prev) => prev.type === "success", {
      then: repeat(exchange),
      else: report,
    }),
  );
  type SpendingSides = Awaited<ReturnType<PlanOf<typeof spending>["rest"]>>;
  type Loop = NonNullable<Awaited<ReturnType<SpendingSides["ifTrue"]>>>;
  assertType<Uninhabited<Loop["next"]>>();

  // A repetition that renews it is fine.
  const renewing = repeat(login);
  type Renewing = NonNullable<PlanOf<typeof renewing>>;
  assertType<Equal<Renewing["next"]["first"], { client: string }>>();
});

Deno.test("plan: what is known after a node", () => {
  // Both sides of `login` ran different steps, and one of them revoked
  // `authorize`: nothing is certain afterwards.
  assertType<Equal<keyof After<typeof login>, never>>();

  // The operations of a file session may not run at all.
  assertType<Equal<keyof After<typeof fileSession>, "open" | "close">>();

  // Every arm of a parallel node runs.
  const both = parallel(authorize, ping);
  assertType<Equal<keyof After<typeof both>, "authorize" | "ping">>();

  // An option of a choice may not.
  const either = choice(authorize, ping);
  assertType<Equal<keyof After<typeof either>, never>>();
  const always = choice(sequence(ping, authorize), authorize);
  assertType<Equal<keyof After<typeof always>, "authorize">>();
});

Deno.test("plan: a forwarded field needs to be known to have a value", async () => {
  const withRefresh = sequence(
    authorize,
    branch(authorize, (prev) => prev.type === "success", {
      then: sequence(
        exchange,
        // `refresh_token` is optional in the token response.
        branch(exchange, present("refresh_token"), {
          then: refresh,
          // The empty sequence: nothing to do.
          else: sequence(),
        }),
      ),
      else: report,
    }),
  );

  const plan: PlanOf<typeof withRefresh> = {
    first: { client: "app" },
    rest: () => ({
      ifTrue: (auth) => ({
        first: { code: auth.code },
        rest: () => ({
          // `tokens.refresh_token` is a string here.
          ifTrue: (tokens) => ({ refresh_token: tokens.refresh_token }),
          ifFalse: () => undefined,
        }),
      }),
      ifFalse: (auth) => ({ reason: auth.reason }),
    }),
  };

  const rotating = authServer("success", { refreshToken: "r1" });
  const [, withToken] = await runPlan(withRefresh, plan, rotating);
  assertEquals(withToken, {
    holds: true,
    result: [
      { token: "token-for-c0de", refresh_token: "r1" },
      { holds: true, result: { token: "via-r1" } },
    ],
  });
  assertEquals(rotating.log, ["authorize", "exchange", "refresh"]);

  const plain = authServer("success");
  const [, withoutToken] = await runPlan(withRefresh, plan, plain);
  assertEquals(withoutToken, {
    holds: true,
    result: [{ token: "token-for-c0de" }, { holds: false, result: [] }],
  });
  assertEquals(plain.log, ["authorize", "exchange"]);

  // Without the inner branch, `refresh` has no plan.
  const unchecked = sequence(exchange, refresh);
  type Known = { readonly authorize: Success };
  type Rest = Awaited<ReturnType<PlanOf<typeof unchecked, Known>["rest"]>>;
  assertType<Uninhabited<Rest>>();
});

Deno.test("plan: a predicate that is no type guard narrows nothing", async () => {
  const retry = sequence(
    ping,
    branch(ping, (prev) => prev.n < 3, { then: ping, else: sequence() }),
  );
  type Sides = Awaited<ReturnType<PlanOf<typeof retry>["rest"]>>;
  assertType<Equal<Parameters<Sides["ifTrue"]>[0], N>>();
  assertType<Equal<Parameters<Sides["ifFalse"]>[0], N>>();

  const plan: PlanOf<typeof retry> = {
    first: { n: 1 },
    rest: () => ({
      ifTrue: ({ n }) => ({ n: n + 1 }),
      ifFalse: () => undefined,
    }),
  };
  assertEquals(await runPlan(retry, plan, echo), [
    { n: 1 },
    { holds: true, result: { n: 2 } },
  ]);
  assertEquals(
    await runPlan(retry, { ...plan, first: { n: 5 } }, echo),
    [{ n: 5 }, { holds: false, result: [] }],
  );
});

Deno.test("plan: the rules hold at run time for a plan that got past the types", async () => {
  // Forwarding another code than the one authorize returned.
  const wrongCode = await assertRejects(
    () =>
      runPlan(login, {
        first: { client: "app" },
        rest: () => ({
          ifTrue: () => ({ code: "forged" }),
          ifFalse: (prev) => ({ reason: prev.reason }),
        }),
      }, authServer("success")),
    InvalidRequestError,
  );
  assertEquals(wrongCode.step, "exchange");

  // exchange after the error variant: refused by its `when`.
  const refused = await assertRejects(
    () =>
      runUntyped(sequence(authorize, exchange), {
        first: { client: "app" },
        rest: () => ({ code: "c0de" }),
      }, authServer("error")),
    StepRefusedError,
  );
  assertEquals(refused.because, "authorize");

  // exchange revokes authorize: a second exchange has nothing to follow.
  const server = authServer("success");
  const spent = await assertRejects(
    () =>
      runUntyped(sequence(authorize, exchange, exchange), {
        first: { client: "app" },
        rest: () => ({
          first: { code: "c0de" },
          rest: () => ({ code: "c0de" }),
        }),
      }, server),
    StepNotAvailableError,
  );
  assertEquals(spent.step, "exchange");
  assertEquals(server.log, ["authorize", "exchange"]);

  // A dependent step before its dependency.
  await assertRejects(
    () => runUntyped(exchange, { code: "c0de" }, authServer("success")),
    StepNotAvailableError,
  );

  // A branch on a step that has not run.
  const early = branch(authorize, (prev) => prev.type === "success", {
    then: ping,
    else: ping,
  });
  assertType<Uninhabited<PlanOf<typeof early>>>();
  const noAnswer = await assertRejects(
    () =>
      runUntyped(early, {
        ifTrue: () => ({ n: 1 }),
        ifFalse: () => ({ n: 1 }),
      }, echo),
    StepNotAvailableError,
  );
  assertEquals(noAnswer.requires, "authorize");
});

// -----------------------------------------------------------------------------
// Parallel
// -----------------------------------------------------------------------------

Deno.test("plan: parallel runs its arms together", async () => {
  let inFlight = 0;
  let peak = 0;
  const slow: StepExecutor = {
    async execute(_name, request) {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return request;
    },
  };

  const fanOut = sequence(ping, parallel(ping, sequence(ping, ping), ping));
  const result = await runPlan(fanOut, {
    first: { n: 0 },
    rest: ({ n }) => [
      { n: n + 1 },
      { first: { n: n + 2 }, rest: (r) => ({ n: r.n * 10 }) },
      { n: n + 3 },
    ],
  }, slow);

  assertType<Equal<typeof result, [N, [N, [N, N], N]]>>();
  assertEquals(result, [{ n: 0 }, [{ n: 1 }, [{ n: 2 }, { n: 20 }], { n: 3 }]]);
  assertEquals(peak, 3);
});

Deno.test("plan: the arms of a parallel node do not see each other", async () => {
  // Arm 0 authorizes; arm 1 exchanges. Arm 1 starts from what was known
  // before the node, where nobody has authorized: it has no plan.
  const racing = parallel(authorize, exchange);
  assertType<Uninhabited<PlanOf<typeof racing>[1]>>();

  // Whatever the timing, it is refused at run time too.
  const server = authServer("success");
  await assertRejects(
    () => runUntyped(racing, [{ client: "app" }, { code: "c0de" }], server),
    StepNotAvailableError,
  );
  // The other arm ran to its end before the node rejected.
  assertEquals(server.log, ["authorize"]);

  // After the node, the responses of every arm are known.
  const after = sequence(
    parallel(authorize, ping),
    branch(authorize, (prev) => prev.type === "success", {
      then: exchange,
      else: report,
    }),
  );
  const [, exchanged] = await runPlan(after, {
    first: [{ client: "app" }, { n: 1 }],
    rest: () => ({
      ifTrue: (auth) => ({ code: auth.code }),
      ifFalse: (auth) => ({ reason: auth.reason }),
    }),
  }, authServer("success"));
  assertEquals(exchanged, {
    holds: true,
    result: { token: "token-for-c0de" },
  });
});

Deno.test("plan: a parallel node settles before it rejects", async () => {
  let finished = 0;
  const executor: StepExecutor = {
    async execute(_name, request) {
      const { n } = request as { n: number };
      await new Promise((resolve) => setTimeout(resolve, n));
      finished++;
      if (n === 1) throw new Error("arm failed");
      return request;
    },
  };

  await assertRejects(
    () => runPlan(parallel(ping, ping), [{ n: 1 }, { n: 10 }], executor),
    Error,
    "arm failed",
  );
  assertEquals(finished, 2);
});

// -----------------------------------------------------------------------------
// Plans that do not fit the node
// -----------------------------------------------------------------------------

Deno.test("plan: a plan of the wrong shape is refused with its position", async () => {
  const untyped = runUntyped;

  const noThen = await assertRejects(
    () => untyped(fileSession, { first: { path: "a.txt" } }, fileSystem()),
    PlanError,
  );
  assertInstanceOf(noThen, PlanError);
  assertEquals(noThen.at, "sequence[0]");

  const noOption = await assertRejects(
    () =>
      untyped(fileSession, {
        first: { path: "a.txt" },
        rest: () => ({
          first: {
            next: { choose: "append", plan: {} },
            rest: () => undefined,
          },
          rest: () => ({ handle: 3 }),
        }),
      }, fileSystem()),
    PlanError,
    'no option "append"',
  );
  assertEquals(noOption.at, "sequence[1][0]");

  await assertRejects(
    () => untyped(parallel(ping, ping), [{ n: 1 }], echo),
    PlanError,
    "expected a tuple of 2 plans",
  );
});

Deno.test("plan: options of a choice that are not steps are chosen by index", async () => {
  const either = choice(sequence(ping, ping), ping);

  const viaSequence = await runPlan(either, {
    choose: 0,
    plan: { first: { n: 1 }, rest: ({ n }) => ({ n: n + 1 }) },
  }, echo);
  assertEquals(viaSequence, { choice: 0, result: [{ n: 1 }, { n: 2 }] });

  const viaStep = await runPlan(
    either,
    { choose: "ping", plan: { n: 7 } },
    echo,
  );
  assertEquals(viaStep, { choice: "ping", result: { n: 7 } });

  if (viaStep.choice === 0) {
    assertType<Equal<typeof viaStep.result, [N, N]>>();
  }
});

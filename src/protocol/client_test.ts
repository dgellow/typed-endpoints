/**
 * Protocol Client Tests
 *
 * Tests for type-safe protocol execution.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { z } from "zod";

import {
  type AvailableSteps,
  createMockExecutor,
  createSession,
  type StepExecutor,
} from "./client.ts";
import { dependentStep, mappedStep, protocol, step } from "./dsl.ts";
import {
  InvalidRequestError,
  InvalidResponseError,
  ProtocolError,
  SessionSpentError,
  StepNotAvailableError,
  StepRefusedError,
  UnknownStepError,
} from "./errors.ts";
import { fromStep } from "./mapping.ts";
import {
  type AuthorizeResponse,
  type ExchangeResponse,
  oauth2AuthCodeProtocol,
} from "./oauth.ts";

// =============================================================================
// Test Protocol Definition
// =============================================================================

const simpleProtocol = protocol({
  name: "SimpleProtocol",
  initial: "start",
  terminal: ["end"],
  steps: {
    start: step({
      name: "start",
      request: z.object({ input: z.string() }),
      response: z.object({ id: z.string(), value: z.number() }),
    }),
    middle: dependentStep({
      name: "middle",
      dependsOn: "start",
      request: (prev: { id: string; value: number }) =>
        z.object({
          id: z.literal(prev.id),
          multiplier: z.number(),
        }),
      response: z.object({ result: z.number() }),
    }),
    end: dependentStep({
      name: "end",
      dependsOn: "middle",
      request: (_prev: { result: number }) =>
        z.object({
          confirm: z.boolean(),
        }),
      response: z.object({ success: z.boolean() }),
    }),
  },
});

// =============================================================================
// Session Creation Tests
// =============================================================================

Deno.test("createSession creates a new session with empty state", () => {
  const mockExecutor: StepExecutor = {
    execute: () => Promise.resolve({}),
  };

  const session = createSession(simpleProtocol, mockExecutor);

  assertEquals(session.responses, {});
  assertEquals(session.history, []);
  assertEquals(session.protocol.name, "SimpleProtocol");
});

Deno.test("createSession session knows available steps", () => {
  const mockExecutor: StepExecutor = {
    execute: () => Promise.resolve({}),
  };

  const session = createSession(simpleProtocol, mockExecutor);

  // Only non-dependent steps should be available initially
  assertEquals(session.canExecute("start"), true);
  assertEquals(session.canExecute("middle"), false);
  assertEquals(session.canExecute("end"), false);
  assertEquals(session.availableSteps(), ["start"]);
});

// =============================================================================
// Step Execution Tests
// =============================================================================

Deno.test("execute runs step and returns response with new session", async () => {
  const mockExecutor: StepExecutor = {
    execute: () => Promise.resolve({ id: "test-123", value: 42 }),
  };

  const session = createSession(simpleProtocol, mockExecutor);
  const { response, session: newSession } = await session.execute("start", {
    input: "hello",
  });

  assertEquals(response, { id: "test-123", value: 42 });
  assertEquals(newSession.responses.start, { id: "test-123", value: 42 });
  assertEquals(newSession.history, ["start"]);
});

Deno.test("execute unlocks dependent steps after completion", async () => {
  const mockExecutor: StepExecutor = {
    execute: () => Promise.resolve({ id: "test-123", value: 42 }),
  };

  const session = createSession(simpleProtocol, mockExecutor);
  const { session: afterStart } = await session.execute("start", {
    input: "hello",
  });

  assertEquals(afterStart.canExecute("start"), true);
  assertEquals(afterStart.canExecute("middle"), true);
  assertEquals(afterStart.canExecute("end"), false);
});

Deno.test("execute validates request against schema", async () => {
  const mockExecutor: StepExecutor = {
    execute: () => Promise.resolve({ id: "test", value: 1 }),
  };

  const session = createSession(simpleProtocol, mockExecutor);

  await assertRejects(
    async () => {
      // @ts-expect-error - intentionally passing invalid request
      await session.execute("start", { wrong: "field" });
    },
    Error,
    "Invalid request",
  );
});

Deno.test("execute throws if dependencies not satisfied", async () => {
  const mockExecutor: StepExecutor = {
    execute: () => Promise.resolve({ result: 100 }),
  };

  const session = createSession(simpleProtocol, mockExecutor);

  await assertRejects(
    async () => {
      // @ts-expect-error - middle depends on start which hasn't been executed
      await session.execute("middle", { id: "test", multiplier: 2 });
    },
    Error,
    'dependency "start" not satisfied',
  );
});

Deno.test("execute chains multiple steps correctly", async () => {
  let stepCount = 0;
  const mockExecutor: StepExecutor = {
    execute: (stepName) => {
      stepCount++;
      switch (stepName) {
        case "start":
          return Promise.resolve({ id: "chain-test", value: 10 });
        case "middle":
          return Promise.resolve({ result: 100 });
        case "end":
          return Promise.resolve({ success: true });
        default:
          throw new Error(`Unknown step: ${stepName}`);
      }
    },
  };

  const session = createSession(simpleProtocol, mockExecutor);

  // Execute start
  const { session: s1 } = await session.execute("start", { input: "go" });
  assertEquals(s1.history, ["start"]);

  // Execute middle (depends on start)
  const { session: s2 } = await s1.execute("middle", {
    id: "chain-test",
    multiplier: 10,
  });
  assertEquals(s2.history, ["start", "middle"]);

  // Execute end (depends on middle)
  const { response, session: s3 } = await s2.execute("end", { confirm: true });
  assertEquals(response, { success: true });
  assertEquals(s3.history, ["start", "middle", "end"]);
  assertEquals(stepCount, 3);
});

Deno.test("execute validates dependent step request with literal type", async () => {
  const mockExecutor: StepExecutor = {
    execute: (stepName) => {
      if (stepName === "start") {
        return Promise.resolve({ id: "correct-id", value: 5 });
      }
      return Promise.resolve({ result: 50 });
    },
  };

  const session = createSession(simpleProtocol, mockExecutor);
  const { session: s1 } = await session.execute("start", { input: "test" });

  // Should fail because id doesn't match the literal from start response
  await assertRejects(
    async () => {
      await s1.execute("middle", {
        id: "wrong-id", // Should be "correct-id"
        multiplier: 10,
      });
    },
    Error,
    "Invalid request",
  );
});

// =============================================================================
// Terminal State Tests
// =============================================================================

Deno.test("isTerminal returns false initially", () => {
  const mockExecutor: StepExecutor = {
    execute: () => Promise.resolve({}),
  };

  const session = createSession(simpleProtocol, mockExecutor);
  assertEquals(session.isTerminal(), false);
});

Deno.test("isTerminal returns true after terminal step", async () => {
  const mockExecutor: StepExecutor = {
    execute: (stepName) => {
      switch (stepName) {
        case "start":
          return Promise.resolve({ id: "t", value: 1 });
        case "middle":
          return Promise.resolve({ result: 1 });
        case "end":
          return Promise.resolve({ success: true });
        default:
          return Promise.resolve({});
      }
    },
  };

  const session = createSession(simpleProtocol, mockExecutor);
  const { session: s1 } = await session.execute("start", { input: "x" });
  const { session: s2 } = await s1.execute("middle", {
    id: "t",
    multiplier: 1,
  });
  const { session: s3 } = await s2.execute("end", { confirm: true });

  assertEquals(s3.isTerminal(), true);
});

// =============================================================================
// Mock Executor Tests
// =============================================================================

Deno.test("createMockExecutor returns configured responses", async () => {
  const executor = createMockExecutor(simpleProtocol, {
    start: { id: "mock-id", value: 99 },
    middle: { result: 999 },
    end: { success: true },
  });

  const session = createSession(simpleProtocol, executor);
  const { response } = await session.execute("start", { input: "test" });

  assertEquals(response, { id: "mock-id", value: 99 });
});

Deno.test("createMockExecutor supports function responses", async () => {
  const executor = createMockExecutor(simpleProtocol, {
    start: (req: { input: string }) => ({
      id: `id-${req.input}`,
      value: req.input.length,
    }),
  });

  const session = createSession(simpleProtocol, executor);
  const { response } = await session.execute("start", { input: "hello" });

  assertEquals(response, { id: "id-hello", value: 5 });
});

Deno.test("createMockExecutor throws for unconfigured steps", async () => {
  const executor = createMockExecutor(simpleProtocol, {
    start: { id: "x", value: 1 },
    // middle not configured
  });

  const session = createSession(simpleProtocol, executor);
  const { session: s1 } = await session.execute("start", { input: "x" });

  await assertRejects(
    async () => {
      await s1.execute("middle", { id: "x", multiplier: 1 });
    },
    Error,
    "No mock response configured",
  );
});

// =============================================================================
// OAuth Protocol Tests
// =============================================================================

Deno.test("OAuth protocol: successful authorization flow", async () => {
  const executor = createMockExecutor(oauth2AuthCodeProtocol, {
    authorize: {
      type: "success",
      code: "auth-code-12345",
      state: "random-state",
    } as AuthorizeResponse,
    exchange: {
      type: "success",
      access_token: "access-token-xyz",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "refresh-token-abc",
    } as ExchangeResponse,
  });

  const session = createSession(oauth2AuthCodeProtocol, executor);

  // Step 1: Authorize
  const { response: authResponse, session: s1 } = await session.execute(
    "authorize",
    {
      response_type: "code",
      client_id: "my-client",
      state: "random-state",
    },
  );

  assertEquals(authResponse.type, "success");
  if (authResponse.type === "success") {
    assertEquals(authResponse.code, "auth-code-12345");
  }

  // Step 2: Exchange (now unlocked)
  assertEquals(s1.canExecute("exchange"), true);

  // The compiler wants to know that authorize succeeded.
  const granted = s1.ready("exchange");
  assert(granted);

  const { response: tokenResponse } = await granted.execute("exchange", {
    grant_type: "authorization_code",
    code: "auth-code-12345", // Must match authorize response
    client_id: "my-client",
    client_secret: "my-secret",
  });

  assertEquals(tokenResponse.type, "success");
  if (tokenResponse.type === "success") {
    assertEquals(tokenResponse.access_token, "access-token-xyz");
  }
});

Deno.test("OAuth protocol: exchange requires correct code", async () => {
  const executor = createMockExecutor(oauth2AuthCodeProtocol, {
    authorize: {
      type: "success",
      code: "correct-code",
      state: "state",
    } as AuthorizeResponse,
  });

  const session = createSession(oauth2AuthCodeProtocol, executor);
  const { session: s1 } = await session.execute("authorize", {
    response_type: "code",
    client_id: "client",
    state: "state",
  });

  const granted = s1.ready("exchange");
  assert(granted);

  // Exchange with wrong code should fail validation
  await assertRejects(
    async () => {
      await granted.execute("exchange", {
        grant_type: "authorization_code",
        code: "wrong-code", // Should be "correct-code"
        client_id: "client",
        client_secret: "secret",
      });
    },
    Error,
    "Invalid request",
  );
});

Deno.test("OAuth protocol: error response blocks exchange", async () => {
  const executor = createMockExecutor(oauth2AuthCodeProtocol, {
    authorize: {
      type: "error",
      error: "access_denied",
      error_description: "User denied access",
    } as AuthorizeResponse,
  });

  const session = createSession(oauth2AuthCodeProtocol, executor);
  const { response: authResponse, session: s1 } = await session.execute(
    "authorize",
    {
      response_type: "code",
      client_id: "client",
      state: "state",
    },
  );

  assertEquals(authResponse.type, "error");

  // The step's guard does not hold, so there is no session to continue with.
  assertEquals(s1.canExecute("exchange"), false);
  assertEquals(s1.ready("exchange"), undefined);

  // Bypassing the types, the session refuses the step.
  await assertRejects(
    async () => {
      // deno-lint-ignore no-explicit-any
      await (s1 as any).execute("exchange", {
        grant_type: "authorization_code",
        code: "any-code",
        client_id: "client",
        client_secret: "secret",
      });
    },
    StepRefusedError,
    '"authorize" does not allow this step',
  );
});

// =============================================================================
// Type-Level Tests (Compile-Time Verification)
// =============================================================================

// These tests verify that the type system correctly tracks protocol state.
// If any of these lines cause a compile error, the type system is broken.

type Steps = (typeof simpleProtocol)["steps"];

// Verify step kinds are correctly identified
type StartIsIndependent = Steps["start"] extends { __kind: "step" } ? true
  : false;
type MiddleIsDependent = Steps["middle"] extends { __kind: "dependent_step" }
  ? true
  : false;
const _checkStartIndep: StartIsIndependent = true;
const _checkMiddleDependent: MiddleIsDependent = true;

// Verify dependency is preserved as literal type (not widened to string)
type MiddleDependsOn = Steps["middle"]["dependsOn"];
const _checkMiddleDep: MiddleDependsOn = "start"; // Must be exactly "start", not string

// Verify AvailableSteps correctly unlocks dependent steps
type StepsAfterStart = AvailableSteps<Steps, "start">;
const _checkMiddleAvailable: "middle" extends StepsAfterStart ? true : false =
  true;
const _checkEndNotAvailable: "end" extends StepsAfterStart ? true : false =
  false;

type StepsAfterMiddle = AvailableSteps<Steps, "start" | "middle">;
const _checkEndAvailable: "end" extends StepsAfterMiddle ? true : false = true;

// =============================================================================
// Type-Level Runtime Tests
// =============================================================================

Deno.test("session state types accumulate correctly", async () => {
  const executor = createMockExecutor(simpleProtocol, {
    start: { id: "typed", value: 42 },
    middle: { result: 100 },
  });

  const session = createSession(simpleProtocol, executor);

  // Initial session has empty responses
  const _initialResponses: Record<string, never> = session.responses;

  const { session: s1 } = await session.execute("start", { input: "test" });

  // After start, responses should include start
  const startResponse: { id: string; value: number } = s1.responses.start;
  assertEquals(startResponse.id, "typed");

  const { session: s2 } = await s1.execute("middle", {
    id: "typed",
    multiplier: 2,
  });

  // After middle, responses should include both
  const _bothResponses: {
    start: { id: string; value: number };
    middle: { result: number };
  } = s2.responses;

  assertEquals(s2.responses.start.value, 42);
  assertEquals(s2.responses.middle.result, 100);
});

// =============================================================================
// Mapped Step Tests
// =============================================================================

const mappedProtocol = protocol({
  name: "MappedProtocol",
  initial: "start",
  terminal: ["finish"],
  steps: {
    start: step({
      name: "start",
      request: z.object({ input: z.string() }),
      response: z.object({ id: z.string(), token: z.string() }),
    }),
    process: mappedStep({
      name: "process",
      dependsOn: "start",
      requestMapping: {
        id: fromStep("start", "id"),
      },
      requestSchema: z.object({
        id: z.string(),
        action: z.string(),
      }),
      response: z.object({ result: z.string() }),
    }),
    finish: mappedStep({
      name: "finish",
      dependsOn: "process",
      requestMapping: {
        token: fromStep("start", "token"),
      },
      requestSchema: z.object({
        token: z.string(),
        confirm: z.boolean(),
      }),
      response: z.object({ done: z.boolean() }),
    }),
  },
});

Deno.test("mappedStep: execute with correct literal value succeeds", async () => {
  const executor = createMockExecutor(mappedProtocol, {
    start: { id: "abc-123", token: "tok-xyz" },
    process: { result: "ok" },
  });

  const session = createSession(mappedProtocol, executor);
  const { session: s1 } = await session.execute("start", { input: "go" });
  const { response } = await s1.execute("process", {
    id: "abc-123",
    action: "do-it",
  });

  assertEquals(response.result, "ok");
});

Deno.test("mappedStep: execute with wrong literal value rejects", async () => {
  const executor = createMockExecutor(mappedProtocol, {
    start: { id: "abc-123", token: "tok-xyz" },
    process: { result: "ok" },
  });

  const session = createSession(mappedProtocol, executor);
  const { session: s1 } = await session.execute("start", { input: "go" });

  await assertRejects(
    async () => {
      await s1.execute("process", {
        id: "wrong-id",
        action: "do-it",
      });
    },
    Error,
    "Invalid request",
  );
});

Deno.test("mappedStep: canExecute returns false before dependency", () => {
  const executor = createMockExecutor(mappedProtocol, {});
  const session = createSession(mappedProtocol, executor);

  assertEquals(session.canExecute("start"), true);
  assertEquals(session.canExecute("process"), false);
  assertEquals(session.canExecute("finish"), false);
});

Deno.test("mappedStep: canExecute returns true after dependency", async () => {
  const executor = createMockExecutor(mappedProtocol, {
    start: { id: "x", token: "t" },
  });

  const session = createSession(mappedProtocol, executor);
  const { session: s1 } = await session.execute("start", { input: "x" });

  assertEquals(s1.canExecute("process"), true);
  // finish depends on "process" AND maps from "start" — "process" not done yet
  assertEquals(s1.canExecute("finish"), false);
});

Deno.test("mappedStep: throws if mapping source not satisfied", async () => {
  const executor = createMockExecutor(mappedProtocol, {
    start: { id: "x", token: "t" },
  });

  const session = createSession(mappedProtocol, executor);

  await assertRejects(
    async () => {
      // @ts-expect-error - process depends on start
      await session.execute("process", { id: "x", action: "a" });
    },
    Error,
    "not satisfied",
  );
});

Deno.test("mappedStep: cross-step mapping (finish reads from start)", async () => {
  const executor = createMockExecutor(mappedProtocol, {
    start: { id: "abc", token: "my-token" },
    process: { result: "ok" },
    finish: { done: true },
  });

  const session = createSession(mappedProtocol, executor);
  const { session: s1 } = await session.execute("start", { input: "go" });
  const { session: s2 } = await s1.execute("process", {
    id: "abc",
    action: "do",
  });

  // finish maps token from "start", depends on "process"
  const { response } = await s2.execute("finish", {
    token: "my-token",
    confirm: true,
  });
  assertEquals(response.done, true);

  // Wrong token should fail
  await assertRejects(
    async () => {
      await s2.execute("finish", {
        token: "wrong-token",
        confirm: true,
      });
    },
    Error,
    "Invalid request",
  );
});

// =============================================================================
// Mixed Protocol (dependentStep + mappedStep)
// =============================================================================

const mixedProtocol = protocol({
  name: "MixedProtocol",
  initial: "init",
  terminal: ["done"],
  steps: {
    init: step({
      name: "init",
      request: z.object({ name: z.string() }),
      response: z.object({ sessionId: z.string(), code: z.string() }),
    }),
    // dependentStep — uses function-based request
    verify: dependentStep({
      name: "verify",
      dependsOn: "init",
      request: (prev: { sessionId: string; code: string }) =>
        z.object({
          sessionId: z.literal(prev.sessionId),
          code: z.literal(prev.code),
        }),
      response: z.object({ verified: z.boolean() }),
    }),
    // mappedStep — uses declarative mapping
    done: mappedStep({
      name: "done",
      dependsOn: "verify",
      requestMapping: {
        sessionId: fromStep("init", "sessionId"),
      },
      requestSchema: z.object({
        sessionId: z.string(),
        confirm: z.boolean(),
      }),
      response: z.object({ success: z.boolean() }),
    }),
  },
});

Deno.test("mixed protocol: dependentStep and mappedStep in same session", async () => {
  const executor = createMockExecutor(mixedProtocol, {
    init: { sessionId: "sess-1", code: "code-2" },
    verify: { verified: true },
    done: { success: true },
  });

  const session = createSession(mixedProtocol, executor);
  const { session: s1 } = await session.execute("init", { name: "test" });

  // dependentStep
  const { session: s2 } = await s1.execute("verify", {
    sessionId: "sess-1",
    code: "code-2",
  });

  // mappedStep
  const { response } = await s2.execute("done", {
    sessionId: "sess-1",
    confirm: true,
  });

  assertEquals(response.success, true);
});

// =============================================================================
// Mapped Step Type-Level Tests
// =============================================================================

type MappedSteps = (typeof mappedProtocol)["steps"];

// mapped_step is not independent
type ProcessIsNotIndependent = MappedSteps["process"] extends { __kind: "step" }
  ? true
  : false;
const _checkProcessNotIndep: ProcessIsNotIndependent = false;

// AvailableSteps works with mapped steps
type MappedStepsAfterStart = AvailableSteps<MappedSteps, "start">;
const _checkProcessAvailable: "process" extends MappedStepsAfterStart ? true
  : false = true;

type MappedStepsInitial = AvailableSteps<MappedSteps, never>;
const _checkOnlyStartInitial: "start" extends MappedStepsInitial ? true
  : false = true;
const _checkProcessNotInitial: "process" extends MappedStepsInitial ? true
  : false = false;

// =============================================================================
// Compile-time request and availability checks
// =============================================================================
//
// Each `@ts-expect-error` below is a call the compiler must reject. If one of
// them starts to compile, `deno check` fails with "unused directive".

Deno.test("execute types the request of dependent and mapped steps", async () => {
  const proto = protocol({
    name: "TypedRequests",
    initial: "start",
    steps: {
      start: step({
        name: "start",
        request: z.object({ user: z.string() }),
        response: z.object({ code: z.string() }),
      }),
      viaFunction: dependentStep({
        name: "viaFunction",
        dependsOn: "start",
        request: (prev: { code: string }) =>
          z.object({ code: z.literal(prev.code), note: z.string().optional() }),
        response: z.object({ ok: z.boolean() }),
      }),
      viaMapping: mappedStep({
        name: "viaMapping",
        dependsOn: "start",
        requestMapping: { code: fromStep("start", "code") },
        requestSchema: z.object({ code: z.string(), count: z.number() }),
        response: z.object({ ok: z.boolean() }),
      }),
    },
  });

  const executor = createMockExecutor(proto, {
    start: { code: "c-1" },
    viaFunction: { ok: true },
    viaMapping: { ok: true },
  });
  const { session } = await createSession(proto, executor).execute("start", {
    user: "u",
  });

  // Valid requests compile and run.
  await session.execute("viaFunction", { code: "c-1" });
  await session.execute("viaFunction", { code: "c-1", note: "n" });
  await session.execute("viaMapping", { code: "c-1", count: 1 });

  // The shape is checked at compile time...
  await assertRejects(() =>
    // @ts-expect-error missing `code`
    session.execute("viaFunction", { note: "n" })
  );
  // An unknown key is a compile error only: z.object() strips it at runtime.
  // @ts-expect-error unknown key
  await session.execute("viaFunction", { code: "c-1", extra: 1 });
  await assertRejects(() =>
    // @ts-expect-error `count` must be a number
    session.execute("viaMapping", { code: "c-1", count: "1" })
  );
  await assertRejects(() =>
    // @ts-expect-error not an object of the request shape
    session.execute("viaMapping", { nope: 1 })
  );

  // ...the forwarded value only at runtime: this compiles and is rejected.
  await assertRejects(
    () => session.execute("viaMapping", { code: "other", count: 1 }),
    Error,
    'Invalid request for "viaMapping"',
  );
});

Deno.test("a mapped step needs every step its mapping reads from", async () => {
  const proto = protocol({
    name: "MultiSource",
    initial: "auth",
    steps: {
      auth: step({
        name: "auth",
        request: z.object({}),
        response: z.object({ token: z.string() }),
      }),
      process: step({
        name: "process",
        request: z.object({}),
        response: z.object({ id: z.string() }),
      }),
      finalize: mappedStep({
        name: "finalize",
        dependsOn: "process",
        requestMapping: {
          token: fromStep("auth", "token"),
          sessionId: fromStep("process", "id"),
        },
        requestSchema: z.object({ token: z.string(), sessionId: z.string() }),
        response: z.object({ ok: z.boolean() }),
      }),
    },
  });

  const executor = createMockExecutor(proto, {
    auth: { token: "t" },
    process: { id: "p" },
    finalize: { ok: true },
  });
  const request = { token: "t", sessionId: "p" };

  const { session: afterProcess } = await createSession(proto, executor)
    .execute("process", {});

  // `process` alone is not enough: the mapping also reads from `auth`.
  await assertRejects(
    // @ts-expect-error finalize is not available yet
    () => afterProcess.execute("finalize", request),
    Error,
    'mapping source "auth"',
  );

  const { session: afterBoth } = await afterProcess.execute("auth", {});
  const { response } = await afterBoth.execute("finalize", request);
  assertEquals(response, { ok: true });
});

// =============================================================================
// Error classes
// =============================================================================

Deno.test("execute raises a distinct error class for each failure mode", async () => {
  const proto = protocol({
    name: "Errors",
    initial: "authorize",
    steps: {
      authorize: step({
        name: "authorize",
        request: z.object({ user: z.string() }),
        response: z.discriminatedUnion("type", [
          z.object({ type: z.literal("ok"), code: z.string() }),
          z.object({ type: z.literal("denied") }),
        ]),
      }),
      exchange: dependentStep({
        name: "exchange",
        dependsOn: "authorize",
        request: (prev: { type: "ok"; code: string } | { type: "denied" }) =>
          prev.type === "ok"
            ? z.object({ code: z.literal(prev.code) })
            : z.never(),
        response: z.object({ token: z.string() }),
      }),
    },
  });

  const catching = async (run: () => Promise<unknown>): Promise<unknown> => {
    try {
      await run();
    } catch (error) {
      return error;
    }
    throw new Error("expected the call to throw");
  };

  // A dependency has not run.
  const fresh = createSession(
    proto,
    createMockExecutor(proto, { authorize: { type: "ok", code: "c" } }),
  );
  const notAvailable = await catching(() =>
    // @ts-expect-error exchange is not available before authorize
    fresh.execute("exchange", { code: "c" })
  );
  assert(notAvailable instanceof StepNotAvailableError);
  assertEquals(notAvailable.requires, "authorize");
  assertEquals(notAvailable.step, "exchange");
  assertEquals(notAvailable.protocol, "Errors");

  // The request does not match the schema: the issues are available as data.
  const invalidRequest = await catching(() =>
    // @ts-expect-error `user` must be a string
    fresh.execute("authorize", { user: 1 })
  );
  assert(invalidRequest instanceof InvalidRequestError);
  assertEquals(invalidRequest.issues.map((i) => i.path), [["user"]]);

  // The dependency ran, but returned the variant that rules the step out.
  const denied = await createSession(
    proto,
    createMockExecutor(proto, { authorize: { type: "denied" } }),
  ).execute("authorize", { user: "u" });
  const refused = await catching(() =>
    denied.session.execute("exchange", { code: "c" })
  );
  assert(refused instanceof StepRefusedError);
  assert(!(refused instanceof InvalidRequestError));
  assertEquals(refused.because, "authorize");

  // The executor returned something that is not the step's response.
  const badServer = createSession(
    proto,
    // deno-lint-ignore no-explicit-any
    createMockExecutor(proto, { authorize: { type: "maybe" } as any }),
  );
  const invalidResponse = await catching(() =>
    badServer.execute("authorize", { user: "u" })
  );
  assert(invalidResponse instanceof InvalidResponseError);
  assert(invalidResponse instanceof ProtocolError);
  assertEquals(invalidResponse.name, "InvalidResponseError");

  // A step name that is not in the protocol.
  const unknown = await catching(() =>
    // @ts-expect-error no such step
    fresh.execute("nope", {})
  );
  assert(unknown instanceof UnknownStepError);
});

// =============================================================================
// OAuth: what the reference protocol revokes
// =============================================================================

Deno.test("OAuth protocol: an authorization code is exchanged once, tokens end with revoke", async () => {
  const executor = createMockExecutor(oauth2AuthCodeProtocol, {
    authorize: {
      type: "success",
      code: "c-1",
      state: "s",
    } as AuthorizeResponse,
    exchange: {
      type: "success",
      access_token: "at",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "rt",
    } as ExchangeResponse,
    refresh: {
      type: "success",
      access_token: "at-2",
      token_type: "Bearer",
      expires_in: 3600,
    } as ExchangeResponse,
    revoke: { revoked: true },
  });
  const exchangeRequest = {
    grant_type: "authorization_code",
    code: "c-1",
    client_id: "client",
    client_secret: "secret",
  } as const;

  const start = createSession(oauth2AuthCodeProtocol, executor, {
    singleUse: true,
  });
  const { session: s1 } = await start.execute("authorize", {
    response_type: "code",
    client_id: "client",
    state: "s",
  });
  const granted = s1.ready("exchange");
  assert(granted);
  const { session: s2 } = await granted.execute("exchange", exchangeRequest);

  // The code is spent: on the returned session by its type, on the earlier
  // one at runtime.
  // @ts-expect-error authorize was revoked by exchange
  void (() => s2.ready("exchange")?.execute("exchange", exchangeRequest));
  assertEquals(s2.canExecute("exchange"), false);
  await assertRejects(
    () => granted.execute("exchange", exchangeRequest),
    SessionSpentError,
  );

  const live = s2.ready("refresh");
  assert(live);
  const { session: s3 } = await live.execute("refresh", {
    grant_type: "refresh_token",
    refresh_token: "rt",
    client_id: "client",
  });

  const revocable = s3.ready("revoke");
  assert(revocable);
  // Only a token of the exchange can be revoked: anything else would
  // leave the grant alive while the session believes it gone.
  await assertRejects(
    () => revocable.execute("revoke", { token: "made-up", client_id: "c" }),
    InvalidRequestError,
  );
  const { session: s4 } = await revocable.execute("revoke", {
    token: "rt",
    client_id: "client",
  });

  // With the tokens revoked, only a new authorization is possible.
  assertEquals(s4.availableSteps(), ["authorize"]);
  assertEquals(s4.ready("refresh"), undefined);
  assertEquals(s4.isTerminal(), true);
});

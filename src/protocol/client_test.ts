/**
 * Protocol Client Tests
 *
 * Tests for type-safe protocol execution.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { z } from "zod";

import {
  type AvailableSteps,
  createMockExecutor,
  createSession,
  type StepExecutor,
} from "./client.ts";
import { dependentStep, protocol, step } from "./dsl.ts";
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

  const { response: tokenResponse } = await s1.execute("exchange", {
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

  // Exchange with wrong code should fail validation
  await assertRejects(
    async () => {
      await s1.execute("exchange", {
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

  // Exchange should fail because authorize returned error (z.never() schema)
  await assertRejects(
    async () => {
      await s1.execute("exchange", {
        grant_type: "authorization_code",
        code: "any-code",
        client_id: "client",
        client_secret: "secret",
      });
    },
    Error,
    "Invalid request",
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

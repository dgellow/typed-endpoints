/**
 * OAuth 2.0 Protocol Tests
 *
 * Tests for the protocol schema DSL using OAuth 2.0 as the example.
 */

import { assertEquals } from "@std/assert";
import { z } from "zod";

import {
  buildDependencyGraph,
  choice,
  dependentStep,
  getStepDependencies,
  getStepNames,
  protocol,
  repeat,
  sequence,
  step,
  topologicalSort,
  validateProtocol,
} from "./dsl.ts";

import {
  AuthorizeRequestSchema,
  AuthorizeResponseSchema,
  authorizeStep,
  exchangeStep,
  oauth2AuthCodeProtocol,
  refreshStep,
} from "./oauth.ts";

// =============================================================================
// Step Creation Tests
// =============================================================================

Deno.test("step() creates a basic step with name, request, and response schemas", () => {
  const myStep = step({
    name: "test",
    request: z.object({ foo: z.string() }),
    response: z.object({ bar: z.number() }),
  });

  assertEquals(myStep.__kind, "step");
  assertEquals(myStep.name, "test");
  assertEquals(myStep.request !== undefined, true);
  assertEquals(myStep.response !== undefined, true);
});

Deno.test("step() includes optional description", () => {
  const myStep = step({
    name: "described",
    description: "A described step",
    request: z.string(),
    response: z.boolean(),
  });

  assertEquals(myStep.description, "A described step");
});

Deno.test("dependentStep() creates a step with request function depending on previous response", () => {
  const depStep = dependentStep({
    name: "dependent",
    dependsOn: "previous",
    request: (prev: { code: string }) =>
      z.object({
        code: z.literal(prev.code),
      }),
    response: z.object({ token: z.string() }),
  });

  assertEquals(depStep.__kind, "dependent_step");
  assertEquals(depStep.name, "dependent");
  assertEquals(depStep.dependsOn, "previous");
  assertEquals(typeof depStep.request, "function");
});

Deno.test("dependentStep() request function generates schema based on previous response", () => {
  const depStep = dependentStep({
    name: "exchange",
    dependsOn: "authorize",
    request: (prev: { code: string }) =>
      z.object({
        code: z.literal(prev.code),
      }),
    response: z.object({ token: z.string() }),
  });

  // Simulate calling with a previous response
  const prevResponse = { code: "abc123" };
  const requestSchema = depStep.request(prevResponse);

  // The schema should validate requests with the exact code
  const validResult = requestSchema.safeParse({ code: "abc123" });
  assertEquals(validResult.success, true);

  // Should reject different codes
  const invalidResult = requestSchema.safeParse({ code: "different" });
  assertEquals(invalidResult.success, false);
});

// =============================================================================
// Composition Tests
// =============================================================================

Deno.test("sequence() creates a sequence of steps", () => {
  const step1 = step({
    name: "first",
    request: z.string(),
    response: z.number(),
  });
  const step2 = step({
    name: "second",
    request: z.number(),
    response: z.boolean(),
  });

  const seq = sequence(step1, step2);

  assertEquals(seq.__kind, "sequence");
  assertEquals(seq.steps.length, 2);
  assertEquals(seq.steps[0].name, "first");
  assertEquals(seq.steps[1].name, "second");
});

Deno.test("repeat() creates a repeatable step (Kleene star)", () => {
  const writeStep = step({
    name: "write",
    request: z.object({ content: z.string() }),
    response: z.object({ bytesWritten: z.number() }),
  });

  const writes = repeat(writeStep);

  assertEquals(writes.__kind, "repeat");
  assertEquals(writes.step.name, "write");
  assertEquals(writes.min, undefined);
  assertEquals(writes.max, undefined);
});

Deno.test("repeat() supports min/max bounds", () => {
  const writeStep = step({
    name: "write",
    request: z.string(),
    response: z.number(),
  });

  const bounded = repeat(writeStep, { min: 1, max: 100 });

  assertEquals(bounded.min, 1);
  assertEquals(bounded.max, 100);
});

Deno.test("choice() creates a choice between alternatives", () => {
  const successStep = step({
    name: "success",
    request: z.object({ data: z.string() }),
    response: z.object({ result: z.string() }),
  });
  const errorStep = step({
    name: "error",
    request: z.object({ code: z.number() }),
    response: z.object({ message: z.string() }),
  });

  const result = choice(successStep, errorStep);

  assertEquals(result.__kind, "choice");
  assertEquals(result.steps.length, 2);
});

// =============================================================================
// Protocol Tests
// =============================================================================

Deno.test("protocol() creates a protocol with steps and metadata", () => {
  const simpleProtocol = protocol({
    name: "SimpleProtocol",
    description: "A simple test protocol",
    initial: "start",
    terminal: ["end"],
    steps: {
      start: step({
        name: "start",
        request: z.object({ input: z.string() }),
        response: z.object({ id: z.string() }),
      }),
      end: step({
        name: "end",
        request: z.object({ id: z.string() }),
        response: z.object({ success: z.boolean() }),
      }),
    },
  });

  assertEquals(simpleProtocol.__kind, "protocol");
  assertEquals(simpleProtocol.name, "SimpleProtocol");
  assertEquals(simpleProtocol.initial, "start");
  assertEquals(simpleProtocol.terminal?.includes("end"), true);
});

// =============================================================================
// OAuth 2.0 Protocol Tests
// =============================================================================

Deno.test("OAuth authorize step has correct structure", () => {
  assertEquals(authorizeStep.__kind, "step");
  assertEquals(authorizeStep.name, "authorize");
});

Deno.test("OAuth authorize step validates authorization request", () => {
  const validRequest = {
    response_type: "code" as const,
    client_id: "my-client",
    redirect_uri: "https://example.com/callback",
    scope: "read write",
    state: "random-state",
  };

  const result = AuthorizeRequestSchema.safeParse(validRequest);
  assertEquals(result.success, true);
});

Deno.test("OAuth authorize step validates success response", () => {
  const successResponse = {
    type: "success" as const,
    code: "authorization-code-123",
    state: "random-state",
  };

  const result = AuthorizeResponseSchema.safeParse(successResponse);
  assertEquals(result.success, true);
});

Deno.test("OAuth authorize step validates error response", () => {
  const errorResponse = {
    type: "error" as const,
    error: "access_denied" as const,
    error_description: "User denied access",
    state: "random-state",
  };

  const result = AuthorizeResponseSchema.safeParse(errorResponse);
  assertEquals(result.success, true);
});

Deno.test("OAuth exchange step is a dependent step", () => {
  assertEquals(exchangeStep.__kind, "dependent_step");
  assertEquals(exchangeStep.dependsOn, "authorize");
});

Deno.test("OAuth exchange step generates request schema from authorize response", () => {
  const authorizeResponse = {
    type: "success" as const,
    code: "auth-code-xyz",
    state: "random-state",
  };

  const requestSchema = exchangeStep.request(authorizeResponse);

  // Should validate request with the exact code from authorize
  const validRequest = {
    grant_type: "authorization_code" as const,
    code: "auth-code-xyz",
    client_id: "my-client",
    client_secret: "secret",
  };

  const result = requestSchema.safeParse(validRequest);
  assertEquals(result.success, true);
});

Deno.test("OAuth exchange step rejects requests with wrong code", () => {
  const authorizeResponse = {
    type: "success" as const,
    code: "correct-code",
    state: "random-state",
  };

  const requestSchema = exchangeStep.request(authorizeResponse);

  const invalidRequest = {
    grant_type: "authorization_code" as const,
    code: "wrong-code",
    client_id: "my-client",
    client_secret: "secret",
  };

  const result = requestSchema.safeParse(invalidRequest);
  assertEquals(result.success, false);
});

Deno.test("OAuth exchange step returns z.never() schema when authorize failed", () => {
  const errorResponse = {
    type: "error" as const,
    error: "access_denied" as const,
  };

  const requestSchema = exchangeStep.request(errorResponse);

  // z.never() should reject everything
  const result = requestSchema.safeParse({
    grant_type: "authorization_code",
    code: "any-code",
    client_id: "my-client",
    client_secret: "secret",
  });

  assertEquals(result.success, false);
});

Deno.test("OAuth refresh step depends on exchange step", () => {
  assertEquals(refreshStep.__kind, "dependent_step");
  assertEquals(refreshStep.dependsOn, "exchange");
});

Deno.test("OAuth refresh step generates request schema from exchange response", () => {
  const exchangeResponse = {
    type: "success" as const,
    access_token: "access-token-123",
    token_type: "Bearer" as const,
    expires_in: 3600,
    refresh_token: "refresh-token-xyz",
  };

  const requestSchema = refreshStep.request(exchangeResponse);

  const validRequest = {
    grant_type: "refresh_token" as const,
    refresh_token: "refresh-token-xyz",
    client_id: "my-client",
  };

  const result = requestSchema.safeParse(validRequest);
  assertEquals(result.success, true);
});

Deno.test("OAuth refresh step returns z.never() when no refresh token available", () => {
  const noRefreshResponse = {
    type: "success" as const,
    access_token: "access-token-123",
    token_type: "Bearer" as const,
    expires_in: 3600,
    // No refresh_token!
  };

  const requestSchema = refreshStep.request(noRefreshResponse);

  const result = requestSchema.safeParse({
    grant_type: "refresh_token",
    refresh_token: "any-token",
    client_id: "my-client",
  });

  assertEquals(result.success, false);
});

Deno.test("OAuth protocol has correct structure", () => {
  assertEquals(oauth2AuthCodeProtocol.__kind, "protocol");
  assertEquals(oauth2AuthCodeProtocol.name, "OAuth2AuthorizationCode");
  assertEquals(oauth2AuthCodeProtocol.initial, "authorize");
  assertEquals(oauth2AuthCodeProtocol.terminal?.includes("revoke"), true);
});

Deno.test("OAuth protocol contains all expected steps", () => {
  const stepNames = Object.keys(oauth2AuthCodeProtocol.steps);
  assertEquals(stepNames.includes("authorize"), true);
  assertEquals(stepNames.includes("exchange"), true);
  assertEquals(stepNames.includes("refresh"), true);
  assertEquals(stepNames.includes("revoke"), true);
});

// =============================================================================
// Protocol Introspection Tests
// =============================================================================

Deno.test("getStepNames() returns all step names from protocol", () => {
  const names = getStepNames(oauth2AuthCodeProtocol);
  assertEquals(names.includes("authorize"), true);
  assertEquals(names.includes("exchange"), true);
  assertEquals(names.includes("refresh"), true);
  assertEquals(names.includes("revoke"), true);
});

Deno.test("getStepDependencies() returns empty array for basic steps", () => {
  const deps = getStepDependencies(authorizeStep);
  assertEquals(deps, []);
});

Deno.test("getStepDependencies() returns dependency for dependent steps", () => {
  const deps = getStepDependencies(exchangeStep);
  assertEquals(deps, ["authorize"]);
});

Deno.test("buildDependencyGraph() builds complete dependency graph", () => {
  const graph = buildDependencyGraph(oauth2AuthCodeProtocol);

  assertEquals(graph.get("authorize"), []);
  assertEquals(graph.get("exchange"), ["authorize"]);
  assertEquals(graph.get("refresh"), ["exchange"]);
  assertEquals(graph.get("revoke"), ["exchange"]);
});

Deno.test("topologicalSort() sorts steps in dependency order", () => {
  const sorted = topologicalSort(oauth2AuthCodeProtocol);

  // authorize must come before exchange
  assertEquals(sorted.indexOf("authorize") < sorted.indexOf("exchange"), true);
  // exchange must come before refresh
  assertEquals(sorted.indexOf("exchange") < sorted.indexOf("refresh"), true);
  // exchange must come before revoke
  assertEquals(sorted.indexOf("exchange") < sorted.indexOf("revoke"), true);
});

Deno.test("validateProtocol() validates well-formed protocol", () => {
  const result = validateProtocol(oauth2AuthCodeProtocol);
  assertEquals(result.valid, true);
  assertEquals(result.errors, []);
});

Deno.test("validateProtocol() detects missing initial step", () => {
  const badProtocol = protocol({
    name: "BadProtocol",
    initial: "nonexistent" as "start",
    steps: {
      start: step({
        name: "start",
        request: z.string(),
        response: z.string(),
      }),
    },
  });

  const result = validateProtocol(badProtocol);
  assertEquals(result.valid, false);
  assertEquals(result.errors.some((e) => e.includes("nonexistent")), true);
});

Deno.test("validateProtocol() detects missing dependency", () => {
  const badProtocol = protocol({
    name: "BadProtocol",
    initial: "step1",
    steps: {
      step1: dependentStep({
        name: "step1",
        dependsOn: "nonexistent",
        request: (_prev: unknown) => z.string(),
        response: z.string(),
      }),
    },
  });

  const result = validateProtocol(badProtocol);
  assertEquals(result.valid, false);
  assertEquals(result.errors.some((e) => e.includes("nonexistent")), true);
});

// =============================================================================
// Type-Level Tests (compile-time checks)
// =============================================================================

Deno.test("step request and response types are accessible", () => {
  const myStep = step({
    name: "typed",
    request: z.object({ input: z.string() }),
    response: z.object({ output: z.number() }),
  });

  // Runtime verification that the types are correct
  const validRequest = { input: "test" };
  const validResponse = { output: 42 };

  assertEquals(myStep.request.parse(validRequest), validRequest);
  assertEquals(myStep.response.parse(validResponse), validResponse);
});

Deno.test("protocol step names are typed as literal union", () => {
  const names = getStepNames(oauth2AuthCodeProtocol);

  // Type should be: ("authorize" | "exchange" | "refresh" | "revoke")[]
  // This is a compile-time check - if types are wrong, this won't compile
  const authorize: (typeof names)[number] = "authorize";
  const exchange: (typeof names)[number] = "exchange";

  assertEquals(authorize, "authorize");
  assertEquals(exchange, "exchange");
});

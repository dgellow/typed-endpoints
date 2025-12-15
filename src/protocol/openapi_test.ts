/**
 * Protocol OpenAPI Extension Tests
 *
 * Tests for converting protocols to x-protocol OpenAPI format.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { assertSnapshot } from "@std/testing/snapshot";
import { z } from "zod";

import { dependentStep, protocol, step } from "./dsl.ts";
import { oauth2AuthCodeProtocol } from "./oauth.ts";
import {
  addProtocolsToSpec,
  addProtocolToSpec,
  protocolToOpenApi,
} from "./openapi.ts";

// =============================================================================
// Test Protocol Definitions
// =============================================================================

const simpleProtocol = protocol({
  name: "SimpleProtocol",
  description: "A simple test protocol",
  initial: "start",
  terminal: ["end"],
  steps: {
    start: step({
      name: "start",
      description: "Initial step",
      request: z.object({ input: z.string() }),
      response: z.object({ id: z.string() }),
    }),
    middle: dependentStep({
      name: "middle",
      dependsOn: "start",
      description: "Middle step",
      request: (_prev: { id: string }) =>
        z.object({ id: z.string(), action: z.string() }),
      response: z.object({ result: z.number() }),
    }),
    end: dependentStep({
      name: "end",
      dependsOn: "middle",
      description: "Final step",
      request: (_prev: { result: number }) =>
        z.object({ confirm: z.boolean() }),
      response: z.object({ success: z.boolean() }),
    }),
  },
});

// Protocol with branching (multiple steps depend on same step)
const branchingProtocol = protocol({
  name: "BranchingProtocol",
  initial: "init",
  terminal: ["success", "failure"],
  steps: {
    init: step({
      name: "init",
      request: z.object({ data: z.string() }),
      response: z.object({ id: z.string(), status: z.string() }),
    }),
    success: dependentStep({
      name: "success",
      dependsOn: "init",
      request: (_prev: { id: string; status: string }) =>
        z.object({ id: z.string() }),
      response: z.object({ completed: z.literal(true) }),
    }),
    failure: dependentStep({
      name: "failure",
      dependsOn: "init",
      request: (_prev: { id: string; status: string }) =>
        z.object({ id: z.string(), reason: z.string() }),
      response: z.object({ completed: z.literal(false) }),
    }),
  },
});

// =============================================================================
// protocolToOpenApi Tests
// =============================================================================

Deno.test("protocolToOpenApi converts simple protocol", async (t) => {
  const result = protocolToOpenApi(simpleProtocol);
  await assertSnapshot(t, result);
});

Deno.test("protocolToOpenApi handles branching (multiple next)", async (t) => {
  const result = protocolToOpenApi(branchingProtocol);
  await assertSnapshot(t, result);
});

Deno.test("protocolToOpenApi converts OAuth protocol", async (t) => {
  const result = protocolToOpenApi(oauth2AuthCodeProtocol);
  await assertSnapshot(t, result);
});

Deno.test("protocolToOpenApi omits undefined fields", () => {
  const minimalProtocol = protocol({
    name: "Minimal",
    initial: "only",
    steps: {
      only: step({
        name: "only",
        request: z.object({}),
        response: z.object({}),
      }),
    },
  });

  const result = protocolToOpenApi(minimalProtocol);

  assertEquals(result.name, "Minimal");
  assertEquals(result.description, undefined);
  assertEquals(result.terminal, undefined);

  const onlyStep = result.steps.find((s) => s.name === "only");
  assertEquals(onlyStep?.dependsOn, undefined);
  assertEquals(onlyStep?.next, undefined);
  assertEquals(onlyStep?.description, undefined);
});

Deno.test("protocolToOpenApi throws on invalid protocol", () => {
  // Create a protocol with invalid dependency
  const invalidProtocol = {
    __kind: "protocol" as const,
    name: "Invalid",
    initial: "start",
    steps: {
      start: {
        __kind: "dependent_step" as const,
        name: "start",
        dependsOn: "nonexistent", // Invalid: refers to non-existent step
        request: () => z.object({}),
        response: z.object({}),
      },
    },
  };

  assertThrows(
    // deno-lint-ignore no-explicit-any
    () => protocolToOpenApi(invalidProtocol as any),
    Error,
    'Invalid protocol "Invalid"',
  );
});

// =============================================================================
// addProtocolToSpec Tests
// =============================================================================

Deno.test("addProtocolToSpec adds x-protocol to spec", () => {
  const spec = {
    openapi: "3.1.0",
    info: { title: "Test API", version: "1.0.0" },
    paths: {},
  };

  const result = addProtocolToSpec(spec, simpleProtocol);

  assertEquals(result.openapi, "3.1.0");
  assertEquals(result.info, { title: "Test API", version: "1.0.0" });
  assertEquals(result["x-protocol"].name, "SimpleProtocol");
});

Deno.test("addProtocolToSpec preserves existing spec properties", () => {
  const spec = {
    openapi: "3.1.0",
    info: { title: "API", version: "1.0.0" },
    paths: { "/users": { get: {} } },
    components: { schemas: {} },
    "x-custom": "value",
  };

  const result = addProtocolToSpec(spec, simpleProtocol);

  assertEquals(result.paths, { "/users": { get: {} } });
  assertEquals(result.components, { schemas: {} });
  assertEquals(result["x-custom"], "value");
});

// =============================================================================
// addProtocolsToSpec Tests
// =============================================================================

Deno.test("addProtocolsToSpec adds multiple protocols", () => {
  const spec = {
    openapi: "3.1.0",
    info: { title: "Test API", version: "1.0.0" },
  };

  const result = addProtocolsToSpec(spec, [
    simpleProtocol,
    branchingProtocol,
    oauth2AuthCodeProtocol,
  ]);

  assertEquals(result["x-protocols"].length, 3);
  assertEquals(result["x-protocols"][0].name, "SimpleProtocol");
  assertEquals(result["x-protocols"][1].name, "BranchingProtocol");
  assertEquals(result["x-protocols"][2].name, "OAuth2AuthorizationCode");
});

Deno.test("addProtocolsToSpec handles empty array", () => {
  const spec = { openapi: "3.1.0" };

  const result = addProtocolsToSpec(spec, []);

  assertEquals(result["x-protocols"], []);
});

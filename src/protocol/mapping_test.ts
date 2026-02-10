import { assertEquals } from "@std/assert";
import { z } from "zod";

import {
  deriveSchemaWithLiterals,
  fromStep,
  getNestedValue,
  isFieldMapping,
} from "./mapping.ts";
import {
  getStepDependencies,
  mappedStep,
  protocol,
  step,
  validateProtocol,
} from "./dsl.ts";

// =============================================================================
// fromStep / isFieldMapping
// =============================================================================

Deno.test("fromStep creates a FieldMapping marker", () => {
  const mapping = fromStep("authorize", "code");
  assertEquals(mapping.__kind, "field_mapping");
  assertEquals(mapping.step, "authorize");
  assertEquals(mapping.path, "code");
});

Deno.test("fromStep supports dot-notation paths", () => {
  const mapping = fromStep("exchange", "data.token");
  assertEquals(mapping.step, "exchange");
  assertEquals(mapping.path, "data.token");
});

Deno.test("isFieldMapping returns true for FieldMapping objects", () => {
  assertEquals(isFieldMapping(fromStep("a", "b")), true);
});

Deno.test("isFieldMapping returns false for non-FieldMapping values", () => {
  assertEquals(isFieldMapping(null), false);
  assertEquals(isFieldMapping(undefined), false);
  assertEquals(isFieldMapping("string"), false);
  assertEquals(isFieldMapping(42), false);
  assertEquals(isFieldMapping({ __kind: "step" }), false);
  assertEquals(isFieldMapping({ step: "a", path: "b" }), false);
});

// =============================================================================
// getNestedValue
// =============================================================================

Deno.test("getNestedValue accesses top-level fields", () => {
  assertEquals(getNestedValue({ code: "abc" }, "code"), "abc");
});

Deno.test("getNestedValue accesses nested fields", () => {
  const obj = { data: { token: "xyz", nested: { deep: 42 } } };
  assertEquals(getNestedValue(obj, "data.token"), "xyz");
  assertEquals(getNestedValue(obj, "data.nested.deep"), 42);
});

Deno.test("getNestedValue returns undefined for missing paths", () => {
  assertEquals(getNestedValue({ a: 1 }, "b"), undefined);
  assertEquals(getNestedValue({ a: { b: 1 } }, "a.c"), undefined);
  assertEquals(getNestedValue({ a: 1 }, "a.b.c"), undefined);
});

Deno.test("getNestedValue handles null/undefined in chain", () => {
  assertEquals(getNestedValue(null, "a"), undefined);
  assertEquals(getNestedValue(undefined, "a"), undefined);
});

// =============================================================================
// deriveSchemaWithLiterals
// =============================================================================

Deno.test("deriveSchemaWithLiterals replaces fields with literals", () => {
  const base = z.object({
    code: z.string(),
    grant_type: z.literal("authorization_code"),
    client_id: z.string(),
  });

  const derived = deriveSchemaWithLiterals(base, { code: "abc123" });

  // Should pass with correct literal
  const good = derived.safeParse({
    code: "abc123",
    grant_type: "authorization_code",
    client_id: "my-app",
  });
  assertEquals(good.success, true);

  // Should reject wrong literal value
  const bad = derived.safeParse({
    code: "wrong-code",
    grant_type: "authorization_code",
    client_id: "my-app",
  });
  assertEquals(bad.success, false);
});

Deno.test("deriveSchemaWithLiterals preserves non-overridden fields", () => {
  const base = z.object({
    a: z.string(),
    b: z.number(),
    c: z.boolean(),
  });

  const derived = deriveSchemaWithLiterals(base, { a: "fixed" });

  // Non-overridden fields accept any valid value
  const result = derived.safeParse({ a: "fixed", b: 99, c: false });
  assertEquals(result.success, true);

  // Non-overridden fields still validate their type
  const bad = derived.safeParse({ a: "fixed", b: "not-a-number", c: false });
  assertEquals(bad.success, false);
});

Deno.test("deriveSchemaWithLiterals with no overrides returns equivalent schema", () => {
  const base = z.object({ x: z.string() });
  const derived = deriveSchemaWithLiterals(base, {});

  assertEquals(derived.safeParse({ x: "anything" }).success, true);
});

Deno.test("deriveSchemaWithLiterals with multiple overrides", () => {
  const base = z.object({
    a: z.string(),
    b: z.string(),
    c: z.string(),
  });

  const derived = deriveSchemaWithLiterals(base, { a: "x", c: "z" });

  assertEquals(
    derived.safeParse({ a: "x", b: "anything", c: "z" }).success,
    true,
  );
  assertEquals(
    derived.safeParse({ a: "wrong", b: "anything", c: "z" }).success,
    false,
  );
  assertEquals(
    derived.safeParse({ a: "x", b: "anything", c: "wrong" }).success,
    false,
  );
});

// =============================================================================
// getStepDependencies with mapped steps
// =============================================================================

Deno.test("getStepDependencies returns dependsOn for mapped step", () => {
  const s = mappedStep({
    name: "exchange",
    dependsOn: "authorize",
    requestMapping: {
      code: fromStep("authorize", "code"),
    },
    requestSchema: z.object({ code: z.string() }),
    response: z.object({ token: z.string() }),
  });

  assertEquals(getStepDependencies(s), ["authorize"]);
});

Deno.test("getStepDependencies returns all referenced steps for multi-step mapping", () => {
  const s = mappedStep({
    name: "finalize",
    dependsOn: "step_b",
    requestMapping: {
      tokenA: fromStep("step_a", "token"),
      codeB: fromStep("step_b", "code"),
    },
    requestSchema: z.object({ tokenA: z.string(), codeB: z.string() }),
    response: z.object({ ok: z.boolean() }),
  });

  const deps = getStepDependencies(s);
  assertEquals(deps.sort(), ["step_a", "step_b"]);
});

Deno.test("getStepDependencies deduplicates when mapping references dependsOn", () => {
  const s = mappedStep({
    name: "exchange",
    dependsOn: "authorize",
    requestMapping: {
      code: fromStep("authorize", "code"),
      state: fromStep("authorize", "state"),
    },
    requestSchema: z.object({ code: z.string(), state: z.string() }),
    response: z.object({ token: z.string() }),
  });

  // "authorize" should appear only once
  assertEquals(getStepDependencies(s), ["authorize"]);
});

Deno.test("getStepDependencies returns empty for plain step", () => {
  const s = step({
    name: "start",
    request: z.object({ input: z.string() }),
    response: z.object({ id: z.string() }),
  });

  assertEquals(getStepDependencies(s), []);
});

// =============================================================================
// validateProtocol with mapped steps
// =============================================================================

Deno.test("validateProtocol validates mapped step dependencies exist", () => {
  const p = protocol({
    name: "BadMapped",
    initial: "start",
    steps: {
      start: step({
        name: "start",
        request: z.object({}),
        response: z.object({ id: z.string() }),
      }),
      bad: mappedStep({
        name: "bad",
        dependsOn: "missing",
        requestMapping: {
          id: fromStep("also_missing", "id"),
        },
        requestSchema: z.object({ id: z.string() }),
        response: z.object({}),
      }),
    },
  });

  const result = validateProtocol(p);
  assertEquals(result.valid, false);
  assertEquals(result.errors.length >= 1, true);
  assertEquals(
    result.errors.some((e) => e.includes("missing")),
    true,
  );
});

Deno.test("validateProtocol passes for valid mapped protocol", () => {
  const p = protocol({
    name: "GoodMapped",
    initial: "start",
    steps: {
      start: step({
        name: "start",
        request: z.object({}),
        response: z.object({ id: z.string() }),
      }),
      end: mappedStep({
        name: "end",
        dependsOn: "start",
        requestMapping: {
          id: fromStep("start", "id"),
        },
        requestSchema: z.object({ id: z.string() }),
        response: z.object({}),
      }),
    },
  });

  const result = validateProtocol(p);
  assertEquals(result.valid, true);
  assertEquals(result.errors, []);
});

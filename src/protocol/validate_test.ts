/**
 * Protocol well-formedness: what `validateProtocol`, `createSession` and the
 * builder types reject.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { z } from "zod";

import { createMockExecutor, createSession } from "./client.ts";
import { mappedStep, protocol, step, validateProtocol } from "./dsl.ts";
import { lookupPath } from "./introspect.ts";
import { deriveSchemaWithLiterals, fromStep } from "./mapping.ts";

const login = step({
  name: "login",
  request: z.object({ user: z.string() }),
  response: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("ok"),
      session: z.object({ token: z.string() }),
      roles: z.array(z.object({ name: z.string() })),
    }),
    z.object({ type: z.literal("error"), message: z.string() }),
  ]),
});

function errorsOf(proto: unknown): string[] {
  return validateProtocol(proto as Parameters<typeof validateProtocol>[0])
    .errors;
}

// =============================================================================
// validateProtocol
// =============================================================================

Deno.test("validateProtocol accepts mappings that the schemas support", () => {
  const proto = protocol({
    name: "Valid",
    initial: "login",
    steps: {
      login,
      profile: mappedStep({
        name: "profile",
        dependsOn: "login",
        requestMapping: {
          // a path inside one variant of a union
          token: fromStep("login", "session.token"),
          // a path through an array index
          role: fromStep("login", "roles.0.name"),
        },
        requestSchema: z.object({ token: z.string(), role: z.string() }),
        response: z.object({ id: z.string() }),
      }),
    },
  });

  assertEquals(validateProtocol(proto), { valid: true, errors: [] });
});

Deno.test("validateProtocol rejects a step whose name differs from its key", () => {
  // The builder rejects this at compile time; a protocol can still be put
  // together from untyped parts.
  const proto = {
    __kind: "protocol",
    name: "Renamed",
    initial: "a",
    steps: {
      a: step({ name: "b", request: z.object({}), response: z.object({}) }),
    },
  };

  assertEquals(errorsOf(proto), [
    'Step "a" has name "b"; the name must equal its key',
  ]);
});

Deno.test("validateProtocol rejects a mapping key that is not a request field", () => {
  const proto = {
    __kind: "protocol",
    name: "BadKey",
    initial: "login",
    steps: {
      login,
      profile: {
        __kind: "mapped_step",
        name: "profile",
        dependsOn: "login",
        requestMapping: { tokn: fromStep("login", "session.token") },
        requestSchema: z.object({ token: z.string() }),
        response: z.object({}),
      },
    },
  };

  assertEquals(errorsOf(proto), [
    'Step "profile" maps field "tokn", which is not in its request schema',
  ]);
});

Deno.test("validateProtocol rejects a mapping path that the source response lacks", () => {
  const proto = protocol({
    name: "BadPath",
    initial: "login",
    steps: {
      login,
      profile: mappedStep({
        name: "profile",
        dependsOn: "login",
        requestMapping: { token: fromStep("login", "session.tokn") },
        requestSchema: z.object({ token: z.string() }),
        response: z.object({}),
      }),
    },
  });

  assertEquals(validateProtocol(proto).errors, [
    'Step "profile" maps field "token" from "login.session.tokn", which is not in the response schema of "login"',
  ]);
});

Deno.test("validateProtocol rejects an initial step that has dependencies", () => {
  const proto = protocol({
    name: "BadInitial",
    initial: "profile",
    steps: {
      login,
      profile: mappedStep({
        name: "profile",
        dependsOn: "login",
        requestMapping: { token: fromStep("login", "session.token") },
        requestSchema: z.object({ token: z.string() }),
        response: z.object({}),
      }),
    },
  });

  assertEquals(validateProtocol(proto).errors, [
    'Initial step "profile" depends on "login"; it can never run first',
  ]);
});

Deno.test("createSession refuses a protocol that fails validation", () => {
  const proto = protocol({
    name: "BadPath",
    initial: "login",
    steps: {
      login,
      profile: mappedStep({
        name: "profile",
        dependsOn: "login",
        requestMapping: { token: fromStep("login", "nope") },
        requestSchema: z.object({ token: z.string() }),
        response: z.object({}),
      }),
    },
  });

  assertThrows(
    () => createSession(proto, createMockExecutor(proto, {})),
    Error,
    'Invalid protocol "BadPath"',
  );
});

// =============================================================================
// Builder types
// =============================================================================

Deno.test("mappedStep rejects a mapping key that is not a request field at compile time", () => {
  mappedStep({
    name: "profile",
    dependsOn: "login",
    requestMapping: {
      token: fromStep("login", "session.token"),
      // @ts-expect-error `tokn` is not a field of the request schema
      tokn: fromStep("login", "session.token"),
    },
    requestSchema: z.object({ token: z.string() }),
    response: z.object({}),
  });
});

Deno.test("protocol rejects a step name that differs from its key at compile time", () => {
  protocol({
    name: "Renamed",
    initial: "a",
    steps: {
      // @ts-expect-error the step is named "b" but registered as "a"
      a: step({ name: "b", request: z.object({}), response: z.object({}) }),
    },
  });
});

// =============================================================================
// lookupPath
// =============================================================================

Deno.test("lookupPath distinguishes found, missing and unknown", () => {
  const schema = z.object({
    a: z.object({ b: z.string().optional() }).nullable(),
    list: z.array(z.object({ id: z.string() })),
    open: z.record(z.string(), z.number()),
    loose: z.looseObject({ known: z.string() }),
  });
  const at = (path: string) => lookupPath(schema, path.split("."), "output");

  assertEquals(at("a.b"), "found");
  assertEquals(at("a.c"), "missing");
  assertEquals(at("a.b.deeper"), "missing");
  assertEquals(at("list.0.id"), "found");
  assertEquals(at("list.id"), "missing");
  assertEquals(at("open.anything"), "unknown");
  assertEquals(at("loose.known"), "found");
  assertEquals(at("loose.other"), "unknown");
});

Deno.test("lookupPath follows the requested side of a pipe", () => {
  const schema = z.object({ n: z.string() }).transform((v) => ({ m: v.n }))
    .pipe(z.object({ m: z.string() }));

  assertEquals(lookupPath(schema, ["n"], "input"), "found");
  assertEquals(lookupPath(schema, ["m"], "input"), "missing");
  assertEquals(lookupPath(schema, ["m"], "output"), "found");
});

// =============================================================================
// deriveSchemaWithLiterals
// =============================================================================

Deno.test("deriveSchemaWithLiterals keeps what the base schema enforces", () => {
  const strict = deriveSchemaWithLiterals(
    z.strictObject({ code: z.string() }),
    { code: "abc" },
  );
  assertEquals(strict.safeParse({ code: "abc" }).success, true);
  assertEquals(strict.safeParse({ code: "abc", extra: 1 }).success, false);

  const refined = deriveSchemaWithLiterals(
    z.object({ code: z.string(), from: z.number(), to: z.number() })
      .refine((v) => v.from <= v.to),
    { code: "abc" },
  );
  assertEquals(
    refined.safeParse({ code: "abc", from: 1, to: 2 }).success,
    true,
  );
  assertEquals(
    refined.safeParse({ code: "abc", from: 2, to: 1 }).success,
    false,
  );

  // The field's own checks still apply to the forwarded value.
  const checked = deriveSchemaWithLiterals(
    z.object({ code: z.string().min(5) }),
    { code: "abc" },
  );
  assertEquals(checked.safeParse({ code: "abc" }).success, false);
});

Deno.test("deriveSchemaWithLiterals compares structured values by value", () => {
  const derived = deriveSchemaWithLiterals(
    z.object({
      owner: z.object({ id: z.string(), tags: z.array(z.string()) }),
    }),
    { owner: { id: "u1", tags: ["a", "b"] } },
  );

  assertEquals(
    derived.safeParse({ owner: { id: "u1", tags: ["a", "b"] } }).success,
    true,
  );
  assertEquals(
    derived.safeParse({ owner: { id: "u1", tags: ["b", "a"] } }).success,
    false,
  );
});

Deno.test("deriveSchemaWithLiterals names the field that does not match", () => {
  const derived = deriveSchemaWithLiterals(
    z.object({ code: z.string(), other: z.string() }),
    { code: "abc" },
  );
  const result = derived.safeParse({ code: "xyz", other: "o" });

  assertEquals(result.success, false);
  assertEquals(result.error?.issues.map((i) => i.path), [["code"]]);
});

Deno.test("a mapped step cannot run when the source response lacks the mapped value", async () => {
  const proto = protocol({
    name: "OptionalSource",
    initial: "exchange",
    steps: {
      exchange: step({
        name: "exchange",
        request: z.object({}),
        response: z.object({ refresh_token: z.string().optional() }),
      }),
      refresh: mappedStep({
        name: "refresh",
        dependsOn: "exchange",
        requestMapping: {
          refresh_token: fromStep("exchange", "refresh_token"),
        },
        requestSchema: z.object({ refresh_token: z.string().optional() }),
        response: z.object({}),
      }),
    },
  });

  const executor = createMockExecutor(proto, { exchange: {}, refresh: {} });
  const { session } = await createSession(proto, executor).execute(
    "exchange",
    {},
  );

  // The response has no refresh_token. Before, the field was then required
  // to be undefined and a request without it passed.
  let message = "";
  try {
    await session.execute("refresh", {});
  } catch (error) {
    message = (error as Error).message;
  }
  assertEquals(
    message,
    'Cannot execute "refresh": field "refresh_token" is mapped from "exchange.refresh_token", which the response of "exchange" does not contain',
  );
});

// =============================================================================
// Structure: names, dependencies, cycles
// =============================================================================

const empty = z.object({});
const first = step({
  name: "first",
  request: empty,
  response: z.object({ x: z.string() }),
});

function dependsOn(name: string, on: string) {
  return {
    __kind: "dependent_step",
    name,
    dependsOn: on,
    request: () => empty,
    response: empty,
  };
}

function structure(steps: Record<string, unknown>, extra = {}) {
  return { __kind: "protocol", name: "P", initial: "first", steps, ...extra };
}

Deno.test("validateProtocol rejects an initial step that is not a step", () => {
  assertEquals(errorsOf(structure({ first }, { initial: "start" })), [
    'Initial step "start" not found in steps',
  ]);
});

Deno.test("validateProtocol rejects a terminal step that is not a step", () => {
  assertEquals(
    errorsOf(structure({ first }, { terminal: ["first", "end"] })),
    ['Terminal step "end" not found in steps'],
  );
});

Deno.test("validateProtocol rejects a dependency on a step that does not exist", () => {
  assertEquals(
    errorsOf(structure({ first, second: dependsOn("second", "ghost") })),
    [`Step "second" depends on "ghost" which doesn't exist`],
  );
});

Deno.test("validateProtocol rejects a mapping from a step that does not exist", () => {
  const second = {
    __kind: "mapped_step",
    name: "second",
    dependsOn: "first",
    requestSchema: z.object({ x: z.string() }),
    requestMapping: { x: fromStep("ghost", "x") },
    response: empty,
  };
  assertEquals(errorsOf(structure({ first, second })), [
    `Step "second" depends on "ghost" which doesn't exist`,
  ]);
});

Deno.test("validateProtocol rejects a dependency cycle", () => {
  const errors = errorsOf(
    structure({
      first,
      second: dependsOn("second", "third"),
      third: dependsOn("third", "second"),
    }),
  );
  assertEquals(errors, ['Circular dependency detected involving "second"']);
});

Deno.test("validateProtocol rejects a step that depends on itself", () => {
  assertEquals(
    errorsOf(structure({ first, second: dependsOn("second", "second") })),
    ['Circular dependency detected involving "second"'],
  );
});

Deno.test("validateProtocol reports every problem, not the first", () => {
  const errors = errorsOf(
    structure(
      { first, second: dependsOn("renamed", "ghost") },
      { initial: "start", terminal: ["end"] },
    ),
  );
  assertEquals(errors.length, 4, errors.join("\n"));
});

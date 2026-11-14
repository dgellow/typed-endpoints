import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { assertSnapshot } from "@std/testing/snapshot";
import { z } from "zod";
import { mappedStep, protocol, step } from "./dsl.ts";
import { fromStep } from "./mapping.ts";
import {
  generateProtocolTypes,
  generateProtocolTypesFromModule,
  stepTypeName,
} from "./typegen.ts";

const FIXTURE = "e2e_tests/fixtures/test-protocol.ts";
const NAMED_FIXTURE = "e2e_tests/fixtures/test-protocol-named.ts";

Deno.test("generateProtocolTypesFromModule produces branded types from fixture", async (t) => {
  const output = await generateProtocolTypesFromModule(FIXTURE, "deno.json");

  // Should contain StepOutput brand infrastructure
  assertEquals(output.includes("StepOutput"), true);

  // Should contain step types
  assertEquals(output.includes("LoginRequest"), true);
  assertEquals(output.includes("LoginResponse"), true);
  assertEquals(output.includes("ProfileRequest"), true);
  assertEquals(output.includes("ProfileResponse"), true);

  // Should have branded mapping for token from login
  assertEquals(
    output.includes('StepOutput<string, "login", "token">'),
    true,
  );

  await assertSnapshot(t, output);
});

Deno.test("generateProtocolTypesFromModule output compiles as valid TypeScript", async () => {
  const output = await generateProtocolTypesFromModule(FIXTURE, "deno.json");

  const tmpFile = await Deno.makeTempFile({ suffix: ".ts" });
  try {
    await Deno.writeTextFile(tmpFile, output);
    const cmd = new Deno.Command("deno", {
      args: ["check", tmpFile],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stderr } = await cmd.output();
    const errorText = new TextDecoder().decode(stderr);
    assertEquals(
      code,
      0,
      `Generated types should compile without errors:\n${errorText}`,
    );
  } finally {
    await Deno.remove(tmpFile);
  }
});

Deno.test("generateProtocolTypesFromModule works with named 'protocol' export", async () => {
  const defaultOutput = await generateProtocolTypesFromModule(
    FIXTURE,
    "deno.json",
  );
  const namedOutput = await generateProtocolTypesFromModule(
    NAMED_FIXTURE,
    "deno.json",
  );

  assertEquals(namedOutput, defaultOutput);
});

// =============================================================================
// Names and keys that are not identifiers
// =============================================================================

async function assertCompiles(source: string): Promise<void> {
  const tmpFile = await Deno.makeTempFile({ suffix: ".ts" });
  try {
    await Deno.writeTextFile(tmpFile, source);
    const { code, stderr } = await new Deno.Command("deno", {
      args: ["check", tmpFile],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(code, 0, `${new TextDecoder().decode(stderr)}\n${source}`);
  } finally {
    await Deno.remove(tmpFile);
  }
}

Deno.test("stepTypeName keeps identifiers and sanitises other names", () => {
  assertEquals(stepTypeName("login"), "Login");
  assertEquals(stepTypeName("exchange_code"), "Exchange_code");
  assertEquals(stepTypeName("getToken"), "GetToken");
  assertEquals(stepTypeName("get-token"), "GetToken");
  assertEquals(stepTypeName("device code / poll"), "DeviceCodePoll");
  assertEquals(stepTypeName("2fa"), "_2fa");
  assertThrows(() => stepTypeName("--"), Error, "Cannot derive a type name");
});

Deno.test("generateProtocolTypes: step names and keys that are not identifiers", async () => {
  const proto = protocol({
    name: "Hyphenated",
    initial: "get-token",
    steps: {
      "get-token": step({
        name: "get-token",
        request: z.object({ "client-id": z.string() }),
        response: z.object({
          "access-token": z.string(),
          nested: z.object({ "refresh token": z.string().optional() }),
        }),
      }),
      "2nd": mappedStep({
        name: "2nd",
        dependsOn: "get-token",
        requestSchema: z.object({
          "access-token": z.string(),
          "refresh token": z.string().optional(),
          "x-trace": z.string(),
        }),
        requestMapping: {
          "access-token": fromStep("get-token", "access-token"),
          "refresh token": fromStep("get-token", "nested.refresh token"),
        },
        response: z.object({ ok: z.boolean() }),
      }),
    },
  });

  const output = generateProtocolTypes(proto);

  assertStringIncludes(
    output,
    'export type GetTokenRequest = { "client-id": string; };',
  );
  assertStringIncludes(
    output,
    '"access-token": StepOutput<string, "get-token", "access-token">;',
  );
  assertStringIncludes(
    output,
    'nested: { "refresh token"?: StepOutput<string, "get-token", "nested.refresh token"> | undefined; };',
  );
  assertStringIncludes(output, "export type _2ndRequest = {");
  assertStringIncludes(output, '"x-trace": string;');

  await assertCompiles(output);
});

Deno.test("generateProtocolTypes: request types are input types, response types are output types", () => {
  const proto = protocol({
    name: "Defaults",
    initial: "search",
    steps: {
      search: step({
        name: "search",
        request: z.object({
          q: z.string(),
          limit: z.number().default(20),
        }),
        response: z.object({
          total: z.number().default(0),
          cursor: z.string().optional(),
        }),
      }),
      next: mappedStep({
        name: "next",
        dependsOn: "search",
        requestSchema: z.object({
          cursor: z.string(),
          limit: z.number().default(20),
        }),
        requestMapping: { cursor: fromStep("search", "cursor") },
        response: z.object({ total: z.number() }),
      }),
    },
  });

  const output = generateProtocolTypes(proto);

  // A default makes the key optional for the caller and present in the result.
  assertStringIncludes(
    output,
    "export type SearchRequest = { q: string; limit?: number | undefined; };",
  );
  assertStringIncludes(
    output,
    'export type SearchResponse = { total: number; cursor?: StepOutput<string, "search", "cursor"> | undefined; };',
  );
  assertStringIncludes(
    output,
    'export type NextRequest = { cursor: StepOutput<string, "search", "cursor">; limit?: number | undefined; };',
  );
});

Deno.test("generateProtocolTypes: two steps with the same type name are an error", () => {
  const proto = protocol({
    name: "Clash",
    initial: "get-token",
    steps: {
      "get-token": step({
        name: "get-token",
        request: z.object({}),
        response: z.object({}),
      }),
      getToken: step({
        name: "getToken",
        request: z.object({}),
        response: z.object({}),
      }),
    },
  });

  assertThrows(
    () => generateProtocolTypes(proto),
    Error,
    'Steps "get-token" and "getToken" generate the same type names (GetTokenRequest, GetTokenResponse)',
  );
});

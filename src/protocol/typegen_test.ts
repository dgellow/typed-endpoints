import { assertEquals } from "@std/assert";
import { assertSnapshot } from "@std/testing/snapshot";
import { generateProtocolTypesFromModule } from "./typegen.ts";

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

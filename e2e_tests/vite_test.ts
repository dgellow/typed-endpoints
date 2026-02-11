import { assertEquals } from "@std/assert";
import { protocolTypesPlugin } from "../src/integrations/vite.ts";

// =============================================================================
// protocolTypesPlugin E2E
// =============================================================================

Deno.test("E2E: protocolTypesPlugin generates compilable TypeScript", async () => {
  const tmpDir = await Deno.makeTempDir();
  const outputPath = `${tmpDir}/protocol-types.ts`;

  const plugin = protocolTypesPlugin({
    protocolModule: "e2e_tests/fixtures/test-protocol.ts",
    outputPath,
    config: "deno.json",
  });

  // deno-lint-ignore no-explicit-any
  const closeBundle = (plugin as any).closeBundle as () => Promise<void>;
  await closeBundle();

  const output = await Deno.readTextFile(outputPath);
  assertEquals(output.includes("StepOutput"), true);
  assertEquals(output.includes('StepOutput<string, "login", "token">'), true);

  // Verify the output compiles
  const cmd = new Deno.Command("deno", {
    args: ["check", outputPath],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stderr } = await cmd.output();
  const errorText = new TextDecoder().decode(stderr);
  assertEquals(
    code,
    0,
    `Generated protocol types should compile:\n${errorText}`,
  );

  await Deno.remove(tmpDir, { recursive: true });
});

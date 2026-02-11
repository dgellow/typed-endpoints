import { assertEquals } from "@std/assert";

const FIXTURE = "e2e_tests/fixtures/test-protocol.ts";

Deno.test("CLI --format protocol generates valid TypeScript", async () => {
  const tmpFile = await Deno.makeTempFile({ suffix: ".ts" });
  try {
    const cmd = new Deno.Command("deno", {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-run",
        "--allow-env",
        "--allow-net",
        "src/cli.ts",
        "--format",
        "protocol",
        "--protocol",
        FIXTURE,
        "-o",
        tmpFile,
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stderr } = await cmd.output();
    const errorText = new TextDecoder().decode(stderr);
    assertEquals(code, 0, `CLI should exit 0:\n${errorText}`);

    const output = await Deno.readTextFile(tmpFile);
    assertEquals(output.includes("StepOutput"), true);
    assertEquals(output.includes("LoginRequest"), true);
    assertEquals(output.includes("ProfileResponse"), true);

    // Verify the output compiles
    const check = new Deno.Command("deno", {
      args: ["check", tmpFile],
      stdout: "piped",
      stderr: "piped",
    });
    const checkResult = await check.output();
    const checkError = new TextDecoder().decode(checkResult.stderr);
    assertEquals(
      checkResult.code,
      0,
      `Generated output should compile:\n${checkError}`,
    );
  } finally {
    await Deno.remove(tmpFile);
  }
});

Deno.test("CLI --format protocol with nonexistent file fails", async () => {
  const tmpFile = await Deno.makeTempFile({ suffix: ".ts" });
  try {
    const cmd = new Deno.Command("deno", {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-run",
        "--allow-env",
        "--allow-net",
        "src/cli.ts",
        "--format",
        "protocol",
        "--protocol",
        "nonexistent.ts",
        "-o",
        tmpFile,
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const { code } = await cmd.output();
    assertEquals(code, 1, "CLI should fail for nonexistent protocol file");
  } finally {
    await Deno.remove(tmpFile).catch(() => {});
  }
});

Deno.test("CLI --format protocol without --protocol fails", async () => {
  const cmd = new Deno.Command("deno", {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-run",
      "--allow-env",
      "--allow-net",
      "src/cli.ts",
      "--format",
      "protocol",
      "-o",
      "/tmp/typed-endpoints-test-never-written.ts",
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const { code } = await cmd.output();
  assertEquals(code, 1, "CLI should fail when --protocol is missing");
});

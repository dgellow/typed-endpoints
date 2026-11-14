import { assertEquals } from "@std/assert";
import { generateContract } from "@/contract/index.ts";

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

// =============================================================================
// Route formats and argument handling
// =============================================================================

const ROUTES = "src/tsgen/fixtures/routes/api";

async function runCli(
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { code, stdout, stderr } = await new Deno.Command("deno", {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-run",
      "--allow-env",
      "--allow-net",
      "src/cli.ts",
      ...args,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decoder = new TextDecoder();
  return {
    code,
    stdout: decoder.decode(stdout),
    stderr: decoder.decode(stderr),
  };
}

async function assertTypeChecks(file: string): Promise<void> {
  const { code, stderr } = await new Deno.Command("deno", {
    args: ["check", file],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assertEquals(code, 0, new TextDecoder().decode(stderr));
}

for (const format of ["types", "client", "routes"]) {
  Deno.test(`CLI --format ${format} writes output that type-checks`, async () => {
    const tmpFile = await Deno.makeTempFile({ suffix: ".ts" });
    try {
      const result = await runCli("-r", ROUTES, "-o", tmpFile, "-f", format);
      assertEquals(result.code, 0, result.stderr);
      assertEquals(
        result.stdout.trim(),
        `Generated ${format} written to ${tmpFile}`,
      );

      const output = await Deno.readTextFile(tmpFile);
      assertEquals(output.length > 0, true);
      await assertTypeChecks(tmpFile);
    } finally {
      await Deno.remove(tmpFile);
    }
  });
}

// The CLI finds this repository's deno.json, so the route files are
// imported in the subprocess that uses its import map: these two tests are
// also what shows that JSON Schema extraction works there.

Deno.test("CLI --format contract writes what generateContract() returns", async () => {
  const output = await Deno.makeTempFile({ suffix: ".json" });
  try {
    const result = await runCli(
      "-r",
      "e2e_tests/fixtures/conformance/routes",
      "-o",
      output,
      "--format",
      "contract",
    );
    assertEquals(result.code, 0, result.stderr);
    assertEquals(
      JSON.parse(await Deno.readTextFile(output)),
      await generateContract({
        routesDirs: ["e2e_tests/fixtures/conformance/routes"],
      }),
    );
  } finally {
    await Deno.remove(output);
  }
});

Deno.test("CLI --format fastapi writes the checked-in Python module", async () => {
  const output = await Deno.makeTempFile({ suffix: ".py" });
  try {
    const result = await runCli(
      "-r",
      "e2e_tests/fixtures/conformance/routes",
      "-o",
      output,
      "--format",
      "fastapi",
    );
    assertEquals(result.code, 0, result.stderr);
    // The module `./scripts/test-python` type-checks and runs.
    assertEquals(
      await Deno.readTextFile(output),
      await Deno.readTextFile("e2e_tests/python/api_generated.py"),
    );
  } finally {
    await Deno.remove(output);
  }
});

Deno.test("CLI --format python-client writes the checked-in Python client", async () => {
  const output = await Deno.makeTempFile({ suffix: ".py" });
  try {
    const result = await runCli(
      "-r",
      "e2e_tests/fixtures/conformance/routes",
      "-o",
      output,
      "--format",
      "python-client",
    );
    assertEquals(result.code, 0, result.stderr);
    assertEquals(
      await Deno.readTextFile(output),
      await Deno.readTextFile("e2e_tests/python/client_generated.py"),
    );
  } finally {
    await Deno.remove(output);
  }
});

Deno.test("CLI --format axum writes the checked-in Rust module", async () => {
  const output = await Deno.makeTempFile({ suffix: ".rs" });
  try {
    const result = await runCli(
      "-r",
      "e2e_tests/fixtures/conformance/routes",
      "-o",
      output,
      "--format",
      "axum",
    );
    assertEquals(result.code, 0, result.stderr);
    // The module `./scripts/test-rust` builds and runs.
    assertEquals(
      await Deno.readTextFile(output),
      await Deno.readTextFile("e2e_tests/rust/src/api_generated.rs"),
    );
  } finally {
    await Deno.remove(output);
  }
});

Deno.test("CLI --format rust-client writes the checked-in Rust client", async () => {
  const output = await Deno.makeTempFile({ suffix: ".rs" });
  try {
    const result = await runCli(
      "-r",
      "e2e_tests/fixtures/conformance/routes",
      "-o",
      output,
      "--format",
      "rust-client",
    );
    assertEquals(result.code, 0, result.stderr);
    // The module whose tests `./scripts/test-rust` runs against two servers.
    assertEquals(
      await Deno.readTextFile(output),
      await Deno.readTextFile("e2e_tests/rust/src/client_generated.rs"),
    );
  } finally {
    await Deno.remove(output);
  }
});

Deno.test("CLI defaults to the types format", async () => {
  const explicit = await Deno.makeTempFile({ suffix: ".ts" });
  const implicit = await Deno.makeTempFile({ suffix: ".ts" });
  try {
    assertEquals(
      (await runCli("-r", ROUTES, "-o", explicit, "-f", "types")).code,
      0,
    );
    assertEquals((await runCli("-r", ROUTES, "-o", implicit)).code, 0);
    assertEquals(
      await Deno.readTextFile(implicit),
      await Deno.readTextFile(explicit),
    );
  } finally {
    await Deno.remove(explicit);
    await Deno.remove(implicit);
  }
});

Deno.test("CLI --help prints the usage and exits 0", async () => {
  const result = await runCli("--help");
  assertEquals(result.code, 0);
  assertEquals(result.stdout.includes("Usage:"), true);
  assertEquals(result.stdout.includes("--format"), true);
});

Deno.test("CLI without --output fails", async () => {
  const result = await runCli("-r", ROUTES);
  assertEquals(result.code, 1);
  assertEquals(result.stderr.includes("--output is required"), true);
});

Deno.test("CLI rejects an unknown format", async () => {
  const result = await runCli("-r", ROUTES, "-o", "unused.ts", "-f", "yaml");
  assertEquals(result.code, 1);
  assertEquals(result.stderr.includes('Invalid format "yaml"'), true);
});

Deno.test("CLI rejects a misspelled option and writes nothing", async () => {
  const dir = await Deno.makeTempDir();
  const out = `${dir}/out.ts`;
  try {
    const result = await runCli("-r", ROUTES, "-o", out, "--formt", "client");
    assertEquals(result.code, 1);
    assertEquals(result.stderr.includes("Unknown option '--formt'"), true);
    assertEquals(
      await Deno.stat(out).then(() => true, () => false),
      false,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("CLI reports a routes directory that does not exist", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const result = await runCli("-r", "no/such/dir", "-o", `${dir}/out.ts`);
    assertEquals(result.code, 1);
    assertEquals(result.stderr.includes("Error generating types:"), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("CLI --convention reads another framework's route layout", async () => {
  const tmpFile = await Deno.makeTempFile({ suffix: ".ts" });
  try {
    const result = await runCli(
      "-r",
      "src/integrations/fixtures/next/app",
      "-o",
      tmpFile,
      "-f",
      "routes",
      "--convention",
      "next",
    );
    assertEquals(result.code, 0, result.stderr);

    const output = await Deno.readTextFile(tmpFile);
    assertEquals(
      output.includes('method: "GET", path: "/api/users/{id}"'),
      true,
      output,
    );
  } finally {
    await Deno.remove(tmpFile);
  }
});

Deno.test("CLI rejects an unknown convention", async () => {
  const result = await runCli("-o", "unused.ts", "--convention", "rails");
  assertEquals(result.code, 1);
  assertEquals(
    result.stderr.includes(
      'Invalid convention "rails". Must be: fresh, next, sveltekit, astro, nitro',
    ),
    true,
    result.stderr,
  );
});

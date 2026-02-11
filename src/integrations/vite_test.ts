import { assertEquals } from "@std/assert";
import { assertSnapshot } from "@std/testing/snapshot";
import { openApiPlugin, protocolTypesPlugin } from "./vite.ts";

// =============================================================================
// Plugin Structure
// =============================================================================

Deno.test("openApiPlugin returns plugin with correct metadata", async (t) => {
  const plugin = openApiPlugin();

  await assertSnapshot(t, {
    name: plugin.name,
    apply: plugin.apply,
  });
});

// =============================================================================
// closeBundle Hook
// =============================================================================

Deno.test("openApiPlugin closeBundle generates spec file", async (t) => {
  const tmpDir = await Deno.makeTempDir();
  const outputPath = `${tmpDir}/openapi.json`;

  const plugin = openApiPlugin({
    routesDir: "src/tsgen/fixtures/routes",
    outputPath,
    info: { title: "Test API", version: "1.0.0" },
  });

  // deno-lint-ignore no-explicit-any
  const closeBundle = (plugin as any).closeBundle as () => Promise<void>;
  await closeBundle();

  const spec = JSON.parse(await Deno.readTextFile(outputPath));
  await assertSnapshot(t, spec);

  await Deno.remove(tmpDir, { recursive: true });
});

Deno.test("openApiPlugin closeBundle creates nested directories", async () => {
  const tmpDir = await Deno.makeTempDir();
  const outputPath = `${tmpDir}/deep/nested/dir/spec.json`;

  const plugin = openApiPlugin({
    routesDir: "src/tsgen/fixtures/routes",
    outputPath,
  });

  // deno-lint-ignore no-explicit-any
  const closeBundle = (plugin as any).closeBundle as () => Promise<void>;
  await closeBundle();

  const spec = JSON.parse(await Deno.readTextFile(outputPath));
  assertEquals(spec.openapi, "3.1.0");

  await Deno.remove(tmpDir, { recursive: true });
});

Deno.test("openApiPlugin closeBundle does not throw on spec generation failure", async () => {
  const plugin = openApiPlugin({
    routesDir: "nonexistent/directory",
    outputPath: "/tmp/typed-endpoints-test-never-written.json",
  });

  // deno-lint-ignore no-explicit-any
  const closeBundle = (plugin as any).closeBundle as () => Promise<void>;

  // Should not throw — errors are caught and logged
  await closeBundle();
});

Deno.test("openApiPlugin closeBundle passes generator options through", async (t) => {
  const tmpDir = await Deno.makeTempDir();
  const outputPath = `${tmpDir}/openapi.json`;

  const plugin = openApiPlugin({
    routesDir: "src/tsgen/fixtures/routes",
    outputPath,
    info: {
      title: "Custom Title",
      version: "2.0.0",
      description: "Custom description",
    },
    servers: [{ url: "https://api.example.com", description: "Production" }],
  });

  // deno-lint-ignore no-explicit-any
  const closeBundle = (plugin as any).closeBundle as () => Promise<void>;
  await closeBundle();

  const spec = JSON.parse(await Deno.readTextFile(outputPath));
  await assertSnapshot(t, spec);

  await Deno.remove(tmpDir, { recursive: true });
});

// =============================================================================
// protocolTypesPlugin
// =============================================================================

Deno.test("protocolTypesPlugin returns plugin with correct metadata", async (t) => {
  const plugin = protocolTypesPlugin({
    protocolModule: "e2e_tests/fixtures/test-protocol.ts",
  });

  await assertSnapshot(t, {
    name: plugin.name,
    apply: plugin.apply,
  });
});

Deno.test("protocolTypesPlugin closeBundle generates types file", async (t) => {
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
  assertEquals(output.includes("LoginRequest"), true);
  await assertSnapshot(t, output);

  await Deno.remove(tmpDir, { recursive: true });
});

Deno.test("protocolTypesPlugin closeBundle creates nested directories", async () => {
  const tmpDir = await Deno.makeTempDir();
  const outputPath = `${tmpDir}/deep/nested/types.ts`;

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

  await Deno.remove(tmpDir, { recursive: true });
});

Deno.test("protocolTypesPlugin closeBundle does not throw on bad module", async () => {
  const plugin = protocolTypesPlugin({
    protocolModule: "nonexistent/protocol.ts",
    outputPath: "/tmp/typed-endpoints-test-never-written.ts",
  });

  // deno-lint-ignore no-explicit-any
  const closeBundle = (plugin as any).closeBundle as () => Promise<void>;

  // Should not throw — errors are caught and logged
  await closeBundle();
});

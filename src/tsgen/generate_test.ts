import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { assertSnapshot } from "@std/testing/snapshot";
import { generateTypes } from "./generate.ts";

const FIXTURES_DIR = new URL("./fixtures/routes/api", import.meta.url).pathname;
const WEBHOOKS_DIR =
  new URL("./fixtures/routes/webhooks", import.meta.url).pathname;

Deno.test("generateTypes", async (t) => {
  const output = await generateTypes({ routesDirs: [FIXTURES_DIR] });
  await assertSnapshot(t, output);
});

Deno.test("generateTypes with config uses subprocess import", async (t) => {
  // This test verifies that when config is provided, the subprocess approach
  // correctly imports route files using the config's import map.
  const output = await generateTypes({
    routesDirs: [FIXTURES_DIR],
    config: "deno.json", // Use project's deno.json
  });

  await assertSnapshot(t, output);
});

Deno.test("generateTypes with multiple directories", async (t) => {
  const output = await generateTypes({
    routesDirs: [FIXTURES_DIR, WEBHOOKS_DIR],
  });

  await assertSnapshot(t, output);
});

Deno.test("generateTypes with client format", async (t) => {
  const output = await generateTypes({
    routesDirs: [FIXTURES_DIR, WEBHOOKS_DIR],
    format: "client",
  });

  await assertSnapshot(t, output);
});

// =============================================================================
// Schema shapes beyond the basics
// =============================================================================

const EDGE_DIR =
  new URL("./fixtures/edge/routes/api", import.meta.url).pathname;
const COLLISION_DIR =
  new URL("./fixtures/collision/routes/api", import.meta.url).pathname;

/** Type-check generated text by writing it next to this file. */
async function assertCompiles(source: string): Promise<void> {
  const dir = new URL(".", import.meta.url).pathname;
  const tmpFile = await Deno.makeTempFile({ dir, suffix: "_generated.ts" });
  try {
    await Deno.writeTextFile(tmpFile, source);
    const { code, stdout, stderr } = await new Deno.Command("deno", {
      args: ["check", tmpFile],
      env: { NO_COLOR: "1" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const output = new TextDecoder().decode(stdout) +
      new TextDecoder().decode(stderr);
    assertEquals(code, 0, `Generated code does not compile:\n${output}`);
  } finally {
    await Deno.remove(tmpFile);
  }
}

Deno.test("generateTypes: recursive schema, input side, JSON wire form", async (t) => {
  const output = await generateTypes({ routesDirs: [EDGE_DIR] });
  await assertSnapshot(t, output);
  await assertCompiles(output);
});

Deno.test("generateTypes: subprocess and in-process output are identical", async () => {
  for (const format of ["types", "client", "routes"] as const) {
    const inProcess = await generateTypes({ routesDirs: [EDGE_DIR], format });
    const subprocess = await generateTypes({
      routesDirs: [EDGE_DIR],
      format,
      config: "deno.json",
    });
    assertEquals(subprocess, inProcess, format);
  }
});

Deno.test("generateTypes: client format types the query and compiles", async (t) => {
  const output = await generateTypes({
    routesDirs: [EDGE_DIR],
    format: "client",
  });
  await assertSnapshot(t, output);
  await assertCompiles(output);
});

Deno.test("generateTypes: a collection under a parameter is a list", async (t) => {
  const output = await generateTypes({
    routesDirs: [EDGE_DIR],
    format: "routes",
  });
  await assertSnapshot(t, output);
  await assertCompiles(output);
});

Deno.test("generateTypes: client format rejects endpoints with the same method name", async () => {
  const error = await assertRejects(
    () => generateTypes({ routesDirs: [COLLISION_DIR], format: "client" }),
    Error,
    "Several endpoints generate the same client method",
  );
  assertStringIncludes(error.message, "users.retrieve: GET /api/users/[id]");
  assertStringIncludes(error.message, "and GET /api/users/[slug]");
  // PUT and PATCH on one path are `replace` and `update`: no collision.
  assertEquals(error.message.includes("users.update"), false);
  assertEquals(error.message.includes("users.replace"), false);
});

Deno.test("generateTypes: routes format rejects duplicate route ids", async () => {
  const error = await assertRejects(
    () => generateTypes({ routesDirs: [COLLISION_DIR], format: "routes" }),
    Error,
    "Several endpoints generate the same route id",
  );
  assertStringIncludes(error.message, "usersRetrieve: GET /api/users/[id]");
  assertStringIncludes(error.message, "operationId");
  assertEquals(error.message.includes("usersUpdate"), false);
});

Deno.test("generateTypes: types format keeps PUT and PATCH apart", async () => {
  const output = await generateTypes({ routesDirs: [COLLISION_DIR] });
  assertStringIncludes(output, "export type UsersByIdPutRequest = ");
  assertStringIncludes(output, "export type UsersByIdPatchRequest = ");
  await assertCompiles(output);
});

Deno.test("generateTypes: a route that cannot be imported fails with its path", async () => {
  const dir = await Deno.makeTempDir({
    dir: new URL("./fixtures", import.meta.url).pathname,
  });
  try {
    await Deno.writeTextFile(`${dir}/broken.ts`, 'throw new Error("boom");\n');
    for (const config of [undefined, "deno.json"]) {
      const error = await assertRejects(
        () => generateTypes({ routesDirs: [dir], config }),
        Error,
        "Failed to import",
      );
      assertStringIncludes(error.message, "broken.ts");
      assertStringIncludes(error.message, "boom");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

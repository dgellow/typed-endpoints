import { assertSnapshot } from "@std/testing/snapshot";
import { generateTypes } from "./generate.ts";

const FIXTURES_DIR = new URL("./fixtures/routes/api", import.meta.url).pathname;

Deno.test("generateTypes", async (t) => {
  const output = await generateTypes({ routesDir: FIXTURES_DIR });
  await assertSnapshot(t, output);
});

Deno.test("generateTypes with config uses subprocess import", async (t) => {
  // This test verifies that when config is provided, the subprocess approach
  // correctly imports route files using the config's import map.
  const output = await generateTypes({
    routesDir: FIXTURES_DIR,
    config: "deno.json", // Use project's deno.json
  });

  await assertSnapshot(t, output);
});

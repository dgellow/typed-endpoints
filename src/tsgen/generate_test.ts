import { assertSnapshot } from "@std/testing/snapshot";
import { generateTypes } from "./generate.ts";

const FIXTURES_DIR = new URL("./fixtures/routes/api", import.meta.url).pathname;

Deno.test("generateTypes", async (t) => {
  const output = await generateTypes({ routesDir: FIXTURES_DIR });
  await assertSnapshot(t, output);
});

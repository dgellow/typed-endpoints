/**
 * The fixture of the generators for other languages, on the TypeScript
 * side.
 *
 * - The checked-in generated files (the FastAPI module, the Python
 *   client, the axum module and the TypeScript client) are what the
 *   generators produce from the fixture's routes.
 * - The recorded refusals are what the routes' TypeScript handlers
 *   answer.
 * - The conformance tests hold against those handlers.
 *
 * `./scripts/test-python` and `./scripts/test-rust` run the same
 * conformance tests against the generated FastAPI application and the
 * generated axum server.
 */

import { assertEquals } from "@std/assert";
import { fileRouter } from "@/integrations/fetch.ts";
import { generateFastApi, generatePythonClient } from "@/python/index.ts";
import { generateAxum, generateRustClient } from "@/rust/index.ts";
import { generateTypes } from "@/tsgen/mod.ts";

import {
  conformance,
  RECORDED_REFUSALS,
  refusals,
} from "./conformance/suite.ts";

const ROUTES = "e2e_tests/fixtures/conformance/routes";
const GENERATED_PYTHON = "e2e_tests/python/api_generated.py";
const GENERATED_PYTHON_CLIENT = "e2e_tests/python/client_generated.py";
const GENERATED_RUST = "e2e_tests/rust/src/api_generated.rs";
const GENERATED_RUST_CLIENT = "e2e_tests/rust/src/client_generated.rs";
const GENERATED_CLIENT = "e2e_tests/fixtures/conformance/api.generated.ts";

Deno.test("conformance: the checked-in generated files are what the generators produce", async () => {
  const python = await generateFastApi({ routesDirs: [ROUTES] });
  const pythonClient = await generatePythonClient({ routesDirs: [ROUTES] });
  const rust = await generateAxum({ routesDirs: [ROUTES] });
  const rustClient = await generateRustClient({ routesDirs: [ROUTES] });
  const client = await generateTypes({
    routesDirs: [ROUTES],
    format: "client",
    clientImport: "@/client/index.ts",
  });

  if (Deno.args.includes("--update")) {
    await Deno.writeTextFile(GENERATED_PYTHON, python);
    await Deno.writeTextFile(GENERATED_PYTHON_CLIENT, pythonClient);
    await Deno.writeTextFile(GENERATED_RUST, rust);
    await Deno.writeTextFile(GENERATED_RUST_CLIENT, rustClient);
    await Deno.writeTextFile(GENERATED_CLIENT, client);
  }
  assertEquals(
    await Deno.readTextFile(GENERATED_PYTHON),
    python,
    `${GENERATED_PYTHON} is stale; run ./scripts/test --update`,
  );
  assertEquals(
    await Deno.readTextFile(GENERATED_PYTHON_CLIENT),
    pythonClient,
    `${GENERATED_PYTHON_CLIENT} is stale; run ./scripts/test --update`,
  );
  assertEquals(
    await Deno.readTextFile(GENERATED_RUST),
    rust,
    `${GENERATED_RUST} is stale; run ./scripts/test --update`,
  );
  assertEquals(
    await Deno.readTextFile(GENERATED_RUST_CLIENT),
    rustClient,
    `${GENERATED_RUST_CLIENT} is stale; run ./scripts/test --update`,
  );
  assertEquals(
    await Deno.readTextFile(GENERATED_CLIENT),
    client,
    `${GENERATED_CLIENT} is stale; run ./scripts/test --update`,
  );
});

// One server for the file: the routes keep their notes in memory, as the
// Python application does.
let server: Deno.HttpServer<Deno.NetAddr> | undefined;
let baseUrl = "";

Deno.test("conformance: the TypeScript server of the fixture starts", async () => {
  server = Deno.serve(
    { port: 0, onListen: () => {} },
    await fileRouter(ROUTES),
  );
  baseUrl = `http://localhost:${server.addr.port}`;
});

Deno.test("conformance: the recorded refusals are what the TypeScript handlers answer", async () => {
  const answers = JSON.stringify(await refusals(baseUrl), null, 2) + "\n";
  if (Deno.args.includes("--update")) {
    await Deno.writeTextFile(RECORDED_REFUSALS, answers);
  }
  assertEquals(
    await Deno.readTextFile(RECORDED_REFUSALS),
    answers,
    "e2e_tests/conformance/refusals.json is stale; run ./scripts/test --update",
  );
});

conformance("typescript", () => baseUrl);

Deno.test("conformance: the TypeScript server of the fixture stops", async () => {
  await server?.shutdown();
});

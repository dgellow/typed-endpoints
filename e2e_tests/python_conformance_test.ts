/**
 * The Python generator's fixture, on the TypeScript side.
 *
 * - The checked-in generated files (the FastAPI module, the Python client
 *   and the TypeScript client) are what the generators produce from the
 *   fixture's routes.
 * - The conformance tests hold against the routes' TypeScript handlers.
 *
 * `./scripts/test-python` runs the same conformance tests against the
 * generated FastAPI application.
 */

import { assertEquals } from "@std/assert";
import { fileRouter } from "@/integrations/fetch.ts";
import { generateFastApi, generatePythonClient } from "@/python/index.ts";
import { generateTypes } from "@/tsgen/mod.ts";

import { conformance } from "./python/conformance.ts";

const ROUTES = "e2e_tests/fixtures/python/routes";
const GENERATED_PYTHON = "e2e_tests/python/api_generated.py";
const GENERATED_PYTHON_CLIENT = "e2e_tests/python/client_generated.py";
const GENERATED_CLIENT = "e2e_tests/fixtures/python/api.generated.ts";

Deno.test("python: the checked-in generated files are what the generators produce", async () => {
  const python = await generateFastApi({ routesDirs: [ROUTES] });
  const pythonClient = await generatePythonClient({ routesDirs: [ROUTES] });
  const client = await generateTypes({
    routesDirs: [ROUTES],
    format: "client",
    clientImport: "@/client/index.ts",
  });

  if (Deno.args.includes("--update")) {
    await Deno.writeTextFile(GENERATED_PYTHON, python);
    await Deno.writeTextFile(GENERATED_PYTHON_CLIENT, pythonClient);
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
    await Deno.readTextFile(GENERATED_CLIENT),
    client,
    `${GENERATED_CLIENT} is stale; run ./scripts/test --update`,
  );
});

// One server for the file: the routes keep their notes in memory, as the
// Python application does.
let server: Deno.HttpServer<Deno.NetAddr> | undefined;
let baseUrl = "";

Deno.test("python: the TypeScript server of the fixture starts", async () => {
  server = Deno.serve(
    { port: 0, onListen: () => {} },
    await fileRouter(ROUTES),
  );
  baseUrl = `http://localhost:${server.addr.port}`;
});

conformance("typescript", () => baseUrl);

Deno.test("python: the TypeScript server of the fixture stops", async () => {
  await server?.shutdown();
});

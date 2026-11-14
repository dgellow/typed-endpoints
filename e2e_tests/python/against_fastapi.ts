/**
 * The conformance tests against the generated FastAPI application.
 *
 * Run by `./scripts/test-python`, which starts the application under uv
 * and passes where it listens in `FASTAPI_URL`.
 */

import { conformance } from "./conformance.ts";

const url = Deno.env.get("FASTAPI_URL");
if (!url) {
  throw new Error("FASTAPI_URL is not set; run ./scripts/test-python");
}

conformance("fastapi", () => url);

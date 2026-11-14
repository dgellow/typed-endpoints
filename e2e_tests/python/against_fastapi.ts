/**
 * The conformance tests against the generated FastAPI application.
 *
 * Run by `./scripts/test-python`, which starts the application under uv
 * and passes where it listens in `FASTAPI_URL`.
 */

import { conformance } from "../conformance/suite.ts";

const url = Deno.env.get("FASTAPI_URL");
if (!url) {
  throw new Error("FASTAPI_URL is not set; run ./scripts/test-python");
}

// The generated module checks a request against the contract, as the
// TypeScript handlers do, and not with Pydantic. What is left is what the
// server does to a request before the router has it.
conformance("fastapi", () => url, {
  differences: {
    "encoded-slash-is-a-slash":
      "an ASGI server decodes the path, and Starlette routes on the decoded one",
  },
});

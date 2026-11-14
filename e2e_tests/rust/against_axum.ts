/**
 * The conformance tests against the generated axum server.
 *
 * Run by `./scripts/test-rust`, which builds and starts the server and
 * passes where it listens in `AXUM_URL`.
 */

import { conformance } from "../conformance/suite.ts";

const url = Deno.env.get("AXUM_URL");
if (!url) {
  throw new Error("AXUM_URL is not set; run ./scripts/test-rust");
}

conformance("axum", () => url, {
  withoutEventStreams: "the Rust generator does not generate them yet",
});

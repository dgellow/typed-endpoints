/**
 * The conformance tests against the generated axum server.
 *
 * Run by `./scripts/test-rust`, which builds and starts the server and
 * passes where it listens in `AXUM_URL`.
 */

import { assertEquals } from "@std/assert";

import { conformance } from "../conformance/suite.ts";

const url = Deno.env.get("AXUM_URL");
if (!url) {
  throw new Error("AXUM_URL is not set; run ./scripts/test-rust");
}

conformance("axum", () => url, {
  withoutEventStreams: "the Rust generator does not generate them yet",
});

// Not in the suite: the TypeScript handlers read a body of any size.
Deno.test("axum: a body larger than axum reads is refused as JSON", async () => {
  // axum's default limit is 2 MB.
  const body = JSON.stringify({ title: "x".repeat(3_000_000), tags: [] });
  const response = await fetch(`${url}/api/notes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  assertEquals(response.status, 413);
  assertEquals(await response.json(), {
    error: "Failed to buffer the request body: length limit exceeded",
  });
});

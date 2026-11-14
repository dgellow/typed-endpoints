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

// Requests are validated by Pydantic, whose rules differ from Zod's here.
conformance("fastapi", () => url, {
  differences: {
    "unicode-digits": "Python's re matches every Unicode digit with \\d",
    "whole-float-is-not-integer": "a strict Pydantic int refuses 2.0",
    "null-for-optional":
      "an optional field is `T | None`, which accepts an explicit null",
    "repeated-query-key": "FastAPI takes the last value of a repeated key",
    "json-as-text": "FastAPI reads a body as JSON only under a JSON type",
    "form-is-400": "FastAPI reports a form body as a validation failure",
    "issues-in-other-words":
      "the codes and messages are Pydantic's, and FastAPI's order",
    "issue-per-union-member":
      "Pydantic reports a union once per member, named in the path",
  },
});

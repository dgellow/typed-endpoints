import { assertEquals } from "@std/assert";
import { z } from "zod";
import { parseSearchParams, validateRequest } from "./validation.ts";

// parseSearchParams tests

Deno.test("parseSearchParams handles single values", () => {
  const params = new URLSearchParams("foo=bar");
  assertEquals(parseSearchParams(params), { foo: "bar" });
});

Deno.test("parseSearchParams handles duplicate keys as array", () => {
  const params = new URLSearchParams("tag=a&tag=b&tag=c");
  assertEquals(parseSearchParams(params), { tag: ["a", "b", "c"] });
});

Deno.test("parseSearchParams handles mixed single and array", () => {
  const params = new URLSearchParams("name=john&tag=a&tag=b");
  assertEquals(parseSearchParams(params), { name: "john", tag: ["a", "b"] });
});

Deno.test("parseSearchParams handles empty params", () => {
  const params = new URLSearchParams("");
  assertEquals(parseSearchParams(params), {});
});

Deno.test("parseSearchParams handles values with special characters", () => {
  const params = new URLSearchParams("q=hello%20world&tag=a%26b");
  assertEquals(parseSearchParams(params), { q: "hello world", tag: "a&b" });
});

// validateRequest tests

Deno.test("validateRequest validates body for POST", async () => {
  const result = await validateRequest(
    {
      json: () => Promise.resolve({ name: "test" }),
      url: "http://example.com",
      params: {},
    },
    { body: z.object({ name: z.string() }) },
    "POST",
  );
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.body, { name: "test" });
  }
});

Deno.test("validateRequest skips body validation for GET", async () => {
  const result = await validateRequest(
    {
      json: () => Promise.reject(new Error("should not be called")),
      url: "http://example.com",
      params: {},
    },
    { body: z.object({ name: z.string() }) },
    "GET",
  );
  assertEquals(result.success, true);
});

Deno.test("validateRequest returns error for invalid body", async () => {
  const result = await validateRequest(
    {
      json: () => Promise.resolve({ name: 123 }),
      url: "http://example.com",
      params: {},
    },
    { body: z.object({ name: z.string() }) },
    "POST",
  );
  assertEquals(result.success, false);
  if (!result.success) {
    assertEquals(result.type, "body");
  }
});

Deno.test("validateRequest returns error for invalid JSON", async () => {
  const result = await validateRequest(
    {
      json: () => Promise.reject(new SyntaxError("Unexpected token")),
      url: "http://example.com",
      params: {},
    },
    { body: z.object({ name: z.string() }) },
    "POST",
  );
  assertEquals(result.success, false);
  if (!result.success) {
    assertEquals(result.type, "json");
    assertEquals(result.error, "Invalid JSON body");
  }
});

Deno.test("validateRequest validates query params", async () => {
  const result = await validateRequest(
    {
      json: () => Promise.resolve({}),
      url: "http://example.com?page=1&limit=10",
      params: {},
    },
    { query: z.object({ page: z.string(), limit: z.string() }) },
    "GET",
  );
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.query, { page: "1", limit: "10" });
  }
});

Deno.test("validateRequest handles array query params", async () => {
  const result = await validateRequest(
    {
      json: () => Promise.resolve({}),
      url: "http://example.com?tags=a&tags=b&tags=c",
      params: {},
    },
    {
      query: z.object({
        tags: z.array(z.string()),
      }),
    },
    "GET",
  );
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.query, { tags: ["a", "b", "c"] });
  }
});

Deno.test("validateRequest handles invalid URL gracefully", async () => {
  const result = await validateRequest(
    {
      json: () => Promise.resolve({}),
      url: "not-a-valid-url",
      params: {},
    },
    { query: z.object({ foo: z.string() }) },
    "GET",
  );
  assertEquals(result.success, false);
  if (!result.success) {
    assertEquals(result.type, "query");
    assertEquals(result.error, "Invalid request URL");
  }
});

Deno.test("validateRequest validates path params", async () => {
  const result = await validateRequest(
    {
      json: () => Promise.resolve({}),
      url: "http://example.com/users/123",
      params: { id: "123" },
    },
    { params: z.object({ id: z.string() }) },
    "GET",
  );
  assertEquals(result.success, true);
  if (result.success) {
    assertEquals(result.data.params, { id: "123" });
  }
});

Deno.test("validateRequest returns error for invalid params", async () => {
  const result = await validateRequest(
    {
      json: () => Promise.resolve({}),
      url: "http://example.com/users/abc",
      params: { id: "abc" },
    },
    { params: z.object({ id: z.string().uuid() }) },
    "GET",
  );
  assertEquals(result.success, false);
  if (!result.success) {
    assertEquals(result.type, "params");
  }
});

Deno.test("validateRequest passes with no schemas defined", async () => {
  const result = await validateRequest(
    {
      json: () => Promise.resolve({}),
      url: "http://example.com",
      params: {},
    },
    {},
    "GET",
  );
  assertEquals(result.success, true);
});

// =============================================================================
// Query lists
// =============================================================================

function queryRequest(search: string) {
  return {
    json: () => Promise.resolve(undefined),
    url: `http://localhost/api/items${search}`,
    params: {},
  };
}

Deno.test("validateRequest: a list field accepts zero, one and several values", async () => {
  const def = { query: z.object({ tag: z.array(z.string()) }) };

  for (
    const [search, expected] of [
      ["", []],
      ["?tag=a", ["a"]],
      ["?tag=a&tag=b", ["a", "b"]],
    ] as const
  ) {
    const result = await validateRequest(queryRequest(search), def, "GET");
    assertEquals(result.success, true, search);
    if (result.success) assertEquals(result.data.query.tag, [...expected]);
  }
});

Deno.test("validateRequest: an optional list stays undefined when absent", async () => {
  const def = {
    query: z.object({
      tag: z.array(z.string()).optional(),
      sort: z.array(z.string()).default(["name"]),
    }),
  };

  const absent = await validateRequest(queryRequest(""), def, "GET");
  // `tag` is not turned into an empty list: the schema allows leaving it out.
  assertEquals(absent.success && absent.data.query, { sort: ["name"] });

  const single = await validateRequest(
    queryRequest("?tag=a&sort=id"),
    def,
    "GET",
  );
  assertEquals(single.success && single.data.query, {
    tag: ["a"],
    sort: ["id"],
  });
});

Deno.test("validateRequest: list items are still validated", async () => {
  const def = { query: z.object({ id: z.array(z.coerce.number().int()) }) };

  const ok = await validateRequest(queryRequest("?id=1"), def, "GET");
  assertEquals(ok.success && ok.data.query, { id: [1] });

  const bad = await validateRequest(queryRequest("?id=x"), def, "GET");
  assertEquals(bad.success, false);
});

Deno.test("validateRequest: a scalar field given several times is rejected by name", async () => {
  const def = { query: z.object({ sort: z.string() }) };
  const result = await validateRequest(
    queryRequest("?sort=a&sort=b"),
    def,
    "GET",
  );

  assertEquals(result.success, false);
  if (!result.success) {
    assertEquals(result.type, "query");
    assertEquals(result.error.includes("sort:"), true, result.error);
  }
});

Deno.test("validateRequest: an error at the root has no empty path prefix", async () => {
  const result = await validateRequest(
    {
      json: () => Promise.resolve("not an object"),
      url: "http://localhost/api/items",
      params: {},
    },
    { body: z.object({ id: z.string() }) },
    "POST",
  );

  assertEquals(result.success, false);
  if (!result.success) {
    assertEquals(
      result.error,
      "Validation error: Invalid input: expected object, received string",
    );
  }
});

// =============================================================================
// Bodies outside POST, PUT and PATCH; issues; content types
// =============================================================================

Deno.test("validateRequest validates a body declared on DELETE", async () => {
  const def = { body: z.object({ ids: z.array(z.string()) }) };
  const request = (body: unknown) => ({
    json: () => Promise.resolve(body),
    url: "http://example.com",
    params: {},
  });

  const valid = await validateRequest(request({ ids: ["1"] }), def, "DELETE");
  assertEquals(valid.success, true);
  if (valid.success) assertEquals(valid.data.body, { ids: ["1"] });

  const invalid = await validateRequest(request({ x: 1 }), def, "DELETE");
  assertEquals(invalid.success, false);
  if (!invalid.success) assertEquals(invalid.type, "body");
});

Deno.test("validateRequest reports each issue with its path and code", async () => {
  const result = await validateRequest(
    {
      json: () => Promise.resolve({ name: 1, tags: ["a", 2] }),
      url: "http://example.com?limit=0",
      params: { id: "x" },
    },
    {
      body: z.object({ name: z.string(), tags: z.array(z.string()) }),
      query: z.object({ limit: z.coerce.number().min(1) }),
    },
    "POST",
  );

  assertEquals(result.success, false);
  if (result.success) return;
  // The body is validated first, and all of its issues are reported.
  assertEquals(result.type, "body");
  assertEquals(
    result.issues.map((issue) => [issue.path, issue.code]),
    [[["name"], "invalid_type"], [["tags", 1], "invalid_type"]],
  );
  assertEquals(
    result.error,
    "Validation error: name: Invalid input: expected string, received number, tags.1: Invalid input: expected string, received number",
  );

  const query = await validateRequest(
    { json: () => Promise.resolve({}), url: "http://example.com?limit=0" },
    { query: z.object({ limit: z.coerce.number().min(1) }) },
    "GET",
  );
  assertEquals(query.success, false);
  if (query.success) return;
  assertEquals(query.type, "query");
  assertEquals(query.issues.map((issue) => [issue.path, issue.code]), [
    [["limit"], "too_small"],
  ]);
});

Deno.test("validateRequest reads a missing body as undefined when it can read the text", async () => {
  const request = (text: string) => ({
    json: () => Promise.reject(new Error("text is read, not json")),
    text: () => Promise.resolve(text),
    url: "http://example.com",
  });

  // A schema that allows no body accepts a request without one.
  const optional = z.object({ reason: z.string() }).optional();
  const none = await validateRequest(request(""), { body: optional }, "DELETE");
  assertEquals(none.success, true);
  if (none.success) assertEquals(none.data.body, undefined);

  const some = await validateRequest(
    request('{"reason":"spam"}'),
    { body: optional },
    "DELETE",
  );
  assertEquals(some.success && some.data.body, { reason: "spam" });

  // A schema that requires one says what is missing.
  const required = await validateRequest(
    request("  "),
    { body: z.object({ reason: z.string() }) },
    "DELETE",
  );
  assertEquals(required.success, false);
  if (required.success) return;
  assertEquals(required.type, "body");
  assertEquals(
    required.error,
    "Validation error: Invalid input: expected object, received undefined",
  );
});

Deno.test("validateRequest tells a body that is not JSON from JSON that is malformed", async () => {
  const def = { body: z.object({ id: z.string() }) };
  const request = (text: string, contentType: string | null) => ({
    json: () => Promise.resolve(JSON.parse(text)),
    text: () => Promise.resolve(text),
    contentType,
    url: "http://example.com",
  });
  const outcome = async (text: string, contentType: string | null) => {
    const result = await validateRequest(
      request(text, contentType),
      def,
      "POST",
    );
    return result.success ? "ok" : `${result.type}: ${result.error}`;
  };

  // Not JSON, and the content type says so.
  assertEquals(
    await outcome("id=1", "application/x-www-form-urlencoded"),
    'content-type: Unsupported content type "application/x-www-form-urlencoded": the body has to be JSON',
  );
  // Malformed JSON that claims to be JSON, or claims nothing.
  assertEquals(
    await outcome("{id:", "application/json; charset=utf-8"),
    "json: Invalid JSON body",
  );
  assertEquals(await outcome("{id:", null), "json: Invalid JSON body");
  // What `fetch()` sends for a string body when no header is set.
  assertEquals(
    await outcome("{id:", "text/plain;charset=UTF-8"),
    "json: Invalid JSON body",
  );
  assertEquals(
    await outcome("{id:", "application/merge-patch+json"),
    "json: Invalid JSON body",
  );

  // JSON under another content type is read: `fetch()` sends a string
  // body as text/plain unless told otherwise.
  assertEquals(await outcome('{"id":"1"}', "text/plain;charset=UTF-8"), "ok");
  assertEquals(await outcome('{"id":"1"}', "application/json"), "ok");
});

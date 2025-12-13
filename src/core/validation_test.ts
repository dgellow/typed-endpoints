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

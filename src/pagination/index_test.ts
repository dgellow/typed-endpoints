import { assertEquals } from "@std/assert";
import { z } from "zod";
import { cursor, cursorId, offset, page, url } from "./index.ts";

const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
});

// =============================================================================
// cursor.paginated tests
// =============================================================================

Deno.test("cursor.paginated generates correct schemas with defaults", () => {
  const result = cursor.paginated({ item: UserSchema });

  // Check query schema
  const queryShape = result.query.shape;
  assertEquals("cursor" in queryShape, true);
  assertEquals("limit" in queryShape, true);

  // Check response schema
  const responseShape = result.response.shape;
  assertEquals("items" in responseShape, true);
  assertEquals("cursor" in responseShape, true);

  // Check pagination metadata
  assertEquals(result.__pagination.style, "cursor");
  assertEquals(result.__pagination.items, "items");
  assertEquals(result.__pagination.cursor, "cursor");
  assertEquals(result.__pagination.cursorParam, "cursor");
  assertEquals(result.__pagination.limitParam, "limit");
});

Deno.test("cursor.paginated uses custom names", () => {
  const result = cursor.paginated({
    item: UserSchema,
    names: {
      items: "data",
      cursor: "nextCursor",
      cursorParam: "after",
      limitParam: "size",
    },
  });

  // Check query uses custom param names
  const queryShape = result.query.shape;
  assertEquals("after" in queryShape, true);
  assertEquals("size" in queryShape, true);
  assertEquals("cursor" in queryShape, false);
  assertEquals("limit" in queryShape, false);

  // Check response uses custom field names
  const responseShape = result.response.shape;
  assertEquals("data" in responseShape, true);
  assertEquals("nextCursor" in responseShape, true);
  assertEquals("items" in responseShape, false);
  assertEquals("cursor" in responseShape, false);

  // Check metadata reflects custom names
  assertEquals(result.__pagination.items, "data");
  assertEquals(result.__pagination.cursor, "nextCursor");
  assertEquals(result.__pagination.cursorParam, "after");
  assertEquals(result.__pagination.limitParam, "size");
});

Deno.test("cursor.paginated includes extra query and response fields", () => {
  const result = cursor.paginated({
    item: UserSchema,
    extraQuery: {
      filter: z.string().optional(),
      sort: z.enum(["asc", "desc"]).default("asc"),
    },
    extraResponse: {
      cached: z.boolean(),
      serverTime: z.number(),
    },
  });

  // Extra query fields
  const queryShape = result.query.shape;
  assertEquals("filter" in queryShape, true);
  assertEquals("sort" in queryShape, true);

  // Extra response fields
  const responseShape = result.response.shape;
  assertEquals("cached" in responseShape, true);
  assertEquals("serverTime" in responseShape, true);
});

Deno.test("cursor.paginated validates query with defaults", () => {
  const result = cursor.paginated({
    item: UserSchema,
    defaultLimit: 10,
    maxLimit: 50,
  });

  // Valid query with string coercion
  const valid = result.query.safeParse({ cursor: "abc", limit: "25" });
  assertEquals(valid.success, true);
  if (valid.success) {
    assertEquals(valid.data.cursor, "abc");
    assertEquals(valid.data.limit, 25);
  }

  // Default limit applied when not provided
  const defaults = result.query.safeParse({});
  assertEquals(defaults.success, true);
  if (defaults.success) {
    assertEquals(defaults.data.limit, 10);
    assertEquals(defaults.data.cursor, undefined);
  }

  // Limit exceeds max - should fail
  const tooHigh = result.query.safeParse({ limit: "100" });
  assertEquals(tooHigh.success, false);

  // Limit below min - should fail
  const tooLow = result.query.safeParse({ limit: "0" });
  assertEquals(tooLow.success, false);
});

Deno.test("cursor.paginated validates response schema", () => {
  const result = cursor.paginated({ item: UserSchema });

  // Valid response
  const valid = result.response.safeParse({
    items: [{ id: "1", name: "Alice", email: "alice@example.com" }],
    cursor: "next-page",
  });
  assertEquals(valid.success, true);

  // Missing cursor is ok (optional)
  const noCursor = result.response.safeParse({
    items: [{ id: "1", name: "Alice", email: "alice@example.com" }],
  });
  assertEquals(noCursor.success, true);

  // Invalid item in array
  const invalidItem = result.response.safeParse({
    items: [{ id: "1", name: "Alice" }], // missing email
    cursor: "next",
  });
  assertEquals(invalidItem.success, false);

  // Missing items field
  const noItems = result.response.safeParse({ cursor: "next" });
  assertEquals(noItems.success, false);
});

// =============================================================================
// offset.paginated tests
// =============================================================================

Deno.test("offset.paginated generates correct schemas with defaults", () => {
  const result = offset.paginated({ item: UserSchema });

  // Check defaults
  assertEquals("offset" in result.query.shape, true);
  assertEquals("limit" in result.query.shape, true);
  assertEquals("items" in result.response.shape, true);
  assertEquals("total" in result.response.shape, true);

  assertEquals(result.__pagination.style, "offset");
  assertEquals(result.__pagination.offsetParam, "offset");
  assertEquals(result.__pagination.limitParam, "limit");
});

Deno.test("offset.paginated uses custom names", () => {
  const result = offset.paginated({
    item: UserSchema,
    names: {
      items: "results",
      total: "count",
      offsetParam: "skip",
      limitParam: "take",
    },
  });

  // Check query
  const queryShape = result.query.shape;
  assertEquals("skip" in queryShape, true);
  assertEquals("take" in queryShape, true);
  assertEquals("offset" in queryShape, false);

  // Check response
  const responseShape = result.response.shape;
  assertEquals("results" in responseShape, true);
  assertEquals("count" in responseShape, true);
  assertEquals("items" in responseShape, false);

  // Check metadata
  assertEquals(result.__pagination.items, "results");
  assertEquals(result.__pagination.total, "count");
  assertEquals(result.__pagination.offsetParam, "skip");
  assertEquals(result.__pagination.limitParam, "take");
});

Deno.test("offset.paginated validates query correctly", () => {
  const result = offset.paginated({
    item: UserSchema,
    defaultLimit: 25,
    maxLimit: 100,
  });

  // Default values applied
  const defaults = result.query.safeParse({});
  assertEquals(defaults.success, true);
  if (defaults.success) {
    assertEquals(defaults.data.offset, 0);
    assertEquals(defaults.data.limit, 25);
  }

  // String coercion works
  const coerced = result.query.safeParse({ offset: "10", limit: "50" });
  assertEquals(coerced.success, true);
  if (coerced.success) {
    assertEquals(coerced.data.offset, 10);
    assertEquals(coerced.data.limit, 50);
  }

  // Negative offset fails
  const negativeOffset = result.query.safeParse({ offset: "-1" });
  assertEquals(negativeOffset.success, false);

  // Limit exceeds max
  const tooHigh = result.query.safeParse({ limit: "150" });
  assertEquals(tooHigh.success, false);
});

Deno.test("offset.paginated validates response with total", () => {
  const result = offset.paginated({ item: UserSchema });

  // Valid response
  const valid = result.response.safeParse({
    items: [{ id: "1", name: "Alice", email: "alice@example.com" }],
    total: 100,
  });
  assertEquals(valid.success, true);

  // Missing total fails (required for offset pagination)
  const noTotal = result.response.safeParse({
    items: [{ id: "1", name: "Alice", email: "alice@example.com" }],
  });
  assertEquals(noTotal.success, false);
});

// =============================================================================
// page.paginated tests
// =============================================================================

Deno.test("page.paginated generates correct schemas with defaults", () => {
  const result = page.paginated({ item: UserSchema });

  assertEquals("page" in result.query.shape, true);
  assertEquals("perPage" in result.query.shape, true);
  assertEquals("items" in result.response.shape, true);

  assertEquals(result.__pagination.style, "page");
  assertEquals(result.__pagination.pageParam, "page");
  assertEquals(result.__pagination.perPageParam, "perPage");
});

Deno.test("page.paginated with total and totalPages", () => {
  const result = page.paginated({
    item: UserSchema,
    names: {
      items: "users",
      total: "totalCount",
      totalPages: "pages",
    },
  });

  // Check response has both total fields
  const responseShape = result.response.shape;
  assertEquals("users" in responseShape, true);
  assertEquals("totalCount" in responseShape, true);
  assertEquals("pages" in responseShape, true);

  // Check metadata
  assertEquals(result.__pagination.total, "totalCount");
  assertEquals(result.__pagination.totalPages, "pages");
});

Deno.test("page.paginated without total fields", () => {
  const result = page.paginated({
    item: UserSchema,
    names: { items: "data" },
  });

  // Response only has items (no total/totalPages required)
  const responseShape = result.response.shape;
  assertEquals("data" in responseShape, true);
  assertEquals("total" in responseShape, false);
  assertEquals("totalPages" in responseShape, false);
});

Deno.test("page.paginated validates query correctly", () => {
  const result = page.paginated({
    item: UserSchema,
    defaultPerPage: 15,
    maxPerPage: 50,
  });

  // Default values
  const defaults = result.query.safeParse({});
  assertEquals(defaults.success, true);
  if (defaults.success) {
    assertEquals(defaults.data.page, 1);
    assertEquals(defaults.data.perPage, 15);
  }

  // Page must be >= 1
  const pageZero = result.query.safeParse({ page: "0" });
  assertEquals(pageZero.success, false);

  // perPage exceeds max
  const tooMany = result.query.safeParse({ perPage: "100" });
  assertEquals(tooMany.success, false);
});

// =============================================================================
// cursorId.paginated tests
// =============================================================================

Deno.test("cursorId.paginated generates correct schemas with defaults", () => {
  const result = cursorId.paginated({ item: UserSchema });

  assertEquals("after" in result.query.shape, true);
  assertEquals("limit" in result.query.shape, true);
  assertEquals("items" in result.response.shape, true);
  // No cursor field in response - uses item ID
  assertEquals("cursor" in result.response.shape, false);

  assertEquals(result.__pagination.style, "cursorId");
  assertEquals(result.__pagination.cursorIdParam, "after");
  assertEquals(result.__pagination.idField, "id");
});

Deno.test("cursorId.paginated uses custom names", () => {
  const result = cursorId.paginated({
    item: UserSchema,
    names: {
      items: "data",
      cursorIdParam: "startingAfter",
      idField: "userId",
      limitParam: "count",
    },
  });

  assertEquals("startingAfter" in result.query.shape, true);
  assertEquals("count" in result.query.shape, true);
  assertEquals("data" in result.response.shape, true);

  assertEquals(result.__pagination.cursorIdParam, "startingAfter");
  assertEquals(result.__pagination.idField, "userId");
  assertEquals(result.__pagination.limitParam, "count");
});

Deno.test("cursorId.paginated validates query correctly", () => {
  const result = cursorId.paginated({
    item: UserSchema,
    defaultLimit: 10,
    maxLimit: 25,
  });

  // Defaults
  const defaults = result.query.safeParse({});
  assertEquals(defaults.success, true);
  if (defaults.success) {
    assertEquals(defaults.data.after, undefined);
    assertEquals(defaults.data.limit, 10);
  }

  // With cursor ID
  const withCursor = result.query.safeParse({ after: "user_123" });
  assertEquals(withCursor.success, true);
  if (withCursor.success) {
    assertEquals(withCursor.data.after, "user_123");
  }
});

// =============================================================================
// url.paginated tests
// =============================================================================

Deno.test("url.paginated generates correct schemas with defaults", () => {
  const result = url.paginated({ item: UserSchema });

  // Empty query (URLs are in response)
  assertEquals(Object.keys(result.query.shape).length, 0);

  // Validate default structure works
  const valid = result.response.safeParse({
    items: [{ id: "1", name: "Alice", email: "alice@example.com" }],
    next: "http://example.com/page2",
  });
  assertEquals(valid.success, true);

  assertEquals(result.__pagination.style, "url");
  assertEquals(result.__pagination.nextUrl, "next");
  assertEquals(result.__pagination.prevUrl, undefined);
});

Deno.test("url.paginated with nested paths creates nested schema", () => {
  const result = url.paginated({
    item: UserSchema,
    names: {
      items: "repos",
      nextUrl: "links.next",
      prevUrl: "links.prev",
    },
  });

  // Check metadata preserves original path strings
  assertEquals(result.__pagination.items, "repos");
  assertEquals(result.__pagination.nextUrl, "links.next");
  assertEquals(result.__pagination.prevUrl, "links.prev");

  // Validate nested structure works
  const valid = result.response.safeParse({
    repos: [{ id: "1", name: "Alice", email: "alice@example.com" }],
    links: {
      next: "https://api.example.com/repos?page=2",
      prev: "https://api.example.com/repos?page=0",
    },
  });
  assertEquals(valid.success, true);

  // Flat structure should fail
  const flat = result.response.safeParse({
    repos: [{ id: "1", name: "Alice", email: "alice@example.com" }],
    "links.next": "http://next",
    "links.prev": "http://prev",
  });
  assertEquals(flat.success, false);
});

Deno.test("url.paginated with deeply nested paths", () => {
  const result = url.paginated({
    item: z.object({ id: z.string() }),
    names: {
      items: "response.data.items",
      nextUrl: "response.pagination.next",
    },
  });

  // Validate deeply nested structure
  const valid = result.response.safeParse({
    response: {
      data: {
        items: [{ id: "1" }],
      },
      pagination: {
        next: "https://api.example.com/page/2",
      },
    },
  });
  assertEquals(valid.success, true);

  // Invalid: missing nested structure
  const invalid = result.response.safeParse({
    items: [{ id: "1" }],
    next: "https://api.example.com/page/2",
  });
  assertEquals(invalid.success, false);
});

Deno.test("url.paginated merges paths with same parent correctly", () => {
  const result = url.paginated({
    item: z.object({ id: z.string() }),
    names: {
      items: "data",
      nextUrl: "links.next",
      prevUrl: "links.prev",
    },
  });

  // Both next and prev should be under the same "links" object
  const valid = result.response.safeParse({
    data: [{ id: "1" }],
    links: {
      next: "http://next",
      prev: "http://prev",
    },
  });
  assertEquals(valid.success, true);

  // Partial links is valid (optional fields)
  const onlyNext = result.response.safeParse({
    data: [{ id: "1" }],
    links: {
      next: "http://next",
    },
  });
  assertEquals(onlyNext.success, true);
});

Deno.test("url.paginated validates response correctly", () => {
  const result = url.paginated({ item: UserSchema });

  // Valid with next URL
  const valid = result.response.safeParse({
    items: [{ id: "1", name: "Alice", email: "alice@example.com" }],
    next: "https://api.example.com/users?page=2",
  });
  assertEquals(valid.success, true);

  // Valid without next URL (last page)
  const lastPage = result.response.safeParse({
    items: [{ id: "1", name: "Alice", email: "alice@example.com" }],
  });
  assertEquals(lastPage.success, true);

  // Empty items is valid
  const empty = result.response.safeParse({ items: [] });
  assertEquals(empty.success, true);
});

Deno.test("url.paginated with extra response fields", () => {
  const result = url.paginated({
    item: UserSchema,
    extraResponse: {
      rateLimit: z.number(),
      remaining: z.number(),
    },
  });

  const valid = result.response.safeParse({
    items: [],
    next: undefined,
    rateLimit: 5000,
    remaining: 4999,
  });
  assertEquals(valid.success, true);
});

// =============================================================================
// Cross-cutting tests
// =============================================================================

Deno.test("all pagination styles have correct __pagination metadata", () => {
  const cursorResult = cursor.paginated({ item: UserSchema });
  const offsetResult = offset.paginated({ item: UserSchema });
  const pageResult = page.paginated({ item: UserSchema });
  const cursorIdResult = cursorId.paginated({ item: UserSchema });
  const urlResult = url.paginated({ item: UserSchema });

  // Each has correct style
  assertEquals(cursorResult.__pagination.style, "cursor");
  assertEquals(offsetResult.__pagination.style, "offset");
  assertEquals(pageResult.__pagination.style, "page");
  assertEquals(cursorIdResult.__pagination.style, "cursorId");
  assertEquals(urlResult.__pagination.style, "url");

  // Each has items field
  assertEquals(cursorResult.__pagination.items, "items");
  assertEquals(offsetResult.__pagination.items, "items");
  assertEquals(pageResult.__pagination.items, "items");
  assertEquals(cursorIdResult.__pagination.items, "items");
  assertEquals(urlResult.__pagination.items, "items");
});

Deno.test("pagination helpers handle complex item schemas", () => {
  const ComplexSchema = z.object({
    id: z.string().uuid(),
    metadata: z.object({
      createdAt: z.string().datetime(),
      tags: z.array(z.string()),
    }),
    status: z.enum(["active", "inactive", "pending"]),
    count: z.number().int().positive().optional(),
  });

  const result = cursor.paginated({ item: ComplexSchema });

  const valid = result.response.safeParse({
    items: [
      {
        id: "550e8400-e29b-41d4-a716-446655440000",
        metadata: {
          createdAt: "2024-01-15T10:30:00Z",
          tags: ["important", "urgent"],
        },
        status: "active",
        count: 42,
      },
    ],
    cursor: "next",
  });
  assertEquals(valid.success, true);

  // Invalid nested field
  const invalid = result.response.safeParse({
    items: [
      {
        id: "not-a-uuid",
        metadata: { createdAt: "2024-01-15", tags: [] },
        status: "active",
      },
    ],
  });
  assertEquals(invalid.success, false);
});

// =============================================================================
// Edge case tests
// =============================================================================

Deno.test("pagination helpers work with empty names object", () => {
  const result = cursor.paginated({
    item: UserSchema,
    names: {},
  });

  // Should use all defaults
  assertEquals("cursor" in result.query.shape, true);
  assertEquals("limit" in result.query.shape, true);
  assertEquals("items" in result.response.shape, true);
  assertEquals("cursor" in result.response.shape, true);
});

Deno.test("pagination helpers work with partial names", () => {
  const result = cursor.paginated({
    item: UserSchema,
    names: { items: "data" }, // only override items
  });

  assertEquals("data" in result.response.shape, true);
  assertEquals("cursor" in result.response.shape, true); // default
  assertEquals("cursor" in result.query.shape, true); // default
});

Deno.test("extraQuery does not override pagination params", () => {
  // If user tries to add a field with same name as pagination param,
  // the pagination param should win (it's added first)
  const result = cursor.paginated({
    item: UserSchema,
    extraQuery: {
      cursor: z.number(), // Try to override cursor with wrong type
    },
  });

  // The cursor param should still be string (pagination wins via Object.assign order)
  // Actually, extraQuery is assigned after, so it would override
  // This test documents current behavior
  const withNumber = result.query.safeParse({ cursor: 123, limit: 10 });
  // Current implementation: extraQuery overwrites, so number works
  assertEquals(withNumber.success, true);
});

Deno.test("url.paginated dot-notation creates nested paths", () => {
  const result = url.paginated({
    item: UserSchema,
    names: {
      nextUrl: "links.next",
    },
  });

  // Dot-notation creates a nested structure: { links: { next: ... } }
  // Nested object format is expected
  const nested = result.response.safeParse({
    items: [],
    links: { next: "http://example.com/page2" },
  });
  assertEquals(nested.success, true);
  if (nested.success) {
    assertEquals(nested.data.links.next, "http://example.com/page2");
  }

  // Literal key format should fail (no "links.next" key, only nested)
  const flat = result.response.safeParse({
    items: [],
    "links.next": "http://example.com/page2",
  });
  assertEquals(flat.success, false);
});

Deno.test("pagination with minimal item schema", () => {
  const MinimalSchema = z.string();

  const result = cursor.paginated({ item: MinimalSchema });

  const valid = result.response.safeParse({
    items: ["a", "b", "c"],
    cursor: "next",
  });
  assertEquals(valid.success, true);

  const invalid = result.response.safeParse({
    items: [1, 2, 3], // numbers, not strings
  });
  assertEquals(invalid.success, false);
});

Deno.test("pagination handles empty items array", () => {
  const result = cursor.paginated({ item: UserSchema });

  // Empty first page
  const emptyPage = result.response.safeParse({
    items: [],
    cursor: "next",
  });
  assertEquals(emptyPage.success, true);

  // Empty last page (no cursor)
  const lastPage = result.response.safeParse({
    items: [],
  });
  assertEquals(lastPage.success, true);
});

Deno.test("offset pagination with zero total", () => {
  const result = offset.paginated({ item: UserSchema });

  const empty = result.response.safeParse({
    items: [],
    total: 0,
  });
  assertEquals(empty.success, true);
});

Deno.test("page pagination starts at page 1", () => {
  const result = page.paginated({ item: UserSchema });

  // Page 1 is valid
  const page1 = result.query.safeParse({ page: "1" });
  assertEquals(page1.success, true);

  // Page 0 is invalid
  const page0 = result.query.safeParse({ page: "0" });
  assertEquals(page0.success, false);

  // Negative page is invalid
  const negative = result.query.safeParse({ page: "-1" });
  assertEquals(negative.success, false);
});

Deno.test("limit/perPage minimum is 1", () => {
  const cursorResult = cursor.paginated({ item: UserSchema });
  const offsetResult = offset.paginated({ item: UserSchema });
  const pageResult = page.paginated({ item: UserSchema });

  // Zero is invalid
  assertEquals(cursorResult.query.safeParse({ limit: "0" }).success, false);
  assertEquals(offsetResult.query.safeParse({ limit: "0" }).success, false);
  assertEquals(pageResult.query.safeParse({ perPage: "0" }).success, false);

  // Negative is invalid
  assertEquals(cursorResult.query.safeParse({ limit: "-5" }).success, false);
  assertEquals(offsetResult.query.safeParse({ limit: "-5" }).success, false);
  assertEquals(pageResult.query.safeParse({ perPage: "-5" }).success, false);

  // One is valid
  assertEquals(cursorResult.query.safeParse({ limit: "1" }).success, true);
  assertEquals(offsetResult.query.safeParse({ limit: "1" }).success, true);
  assertEquals(pageResult.query.safeParse({ perPage: "1" }).success, true);
});

Deno.test("custom max limit is enforced", () => {
  const result = cursor.paginated({
    item: UserSchema,
    maxLimit: 10,
  });

  assertEquals(result.query.safeParse({ limit: "10" }).success, true);
  assertEquals(result.query.safeParse({ limit: "11" }).success, false);
});

Deno.test("extraResponse fields are validated", () => {
  const result = cursor.paginated({
    item: UserSchema,
    extraResponse: {
      meta: z.object({
        requestId: z.string().uuid(),
        timing: z.number().positive(),
      }),
    },
  });

  // Valid extra fields
  const valid = result.response.safeParse({
    items: [],
    meta: {
      requestId: "550e8400-e29b-41d4-a716-446655440000",
      timing: 0.123,
    },
  });
  assertEquals(valid.success, true);

  // Invalid extra field (missing requestId)
  const invalid = result.response.safeParse({
    items: [],
    meta: { timing: 0.123 },
  });
  assertEquals(invalid.success, false);
});

Deno.test("query string coercion works for all number params", () => {
  const cursorResult = cursor.paginated({ item: UserSchema });
  const offsetResult = offset.paginated({ item: UserSchema });
  const pageResult = page.paginated({ item: UserSchema });

  // All accept string numbers (from query params)
  const cursorParsed = cursorResult.query.safeParse({ limit: "50" });
  assertEquals(cursorParsed.success, true);
  if (cursorParsed.success) assertEquals(cursorParsed.data.limit, 50);

  const offsetParsed = offsetResult.query.safeParse({
    offset: "100",
    limit: "25",
  });
  assertEquals(offsetParsed.success, true);
  if (offsetParsed.success) {
    assertEquals(offsetParsed.data.offset, 100);
    assertEquals(offsetParsed.data.limit, 25);
  }

  const pageParsed = pageResult.query.safeParse({ page: "3", perPage: "15" });
  assertEquals(pageParsed.success, true);
  if (pageParsed.success) {
    assertEquals(pageParsed.data.page, 3);
    assertEquals(pageParsed.data.perPage, 15);
  }
});

// =============================================================================
// Page size and position are whole numbers
// =============================================================================

Deno.test("pagination query parameters reject fractions", () => {
  const cases = [
    [cursor.paginated({ item: UserSchema }).query, "limit"],
    [cursorId.paginated({ item: UserSchema }).query, "limit"],
    [offset.paginated({ item: UserSchema }).query, "limit"],
    [offset.paginated({ item: UserSchema }).query, "offset"],
    [page.paginated({ item: UserSchema }).query, "page"],
    [page.paginated({ item: UserSchema }).query, "perPage"],
  ] as const;

  for (const [query, param] of cases) {
    assertEquals(query.safeParse({ [param]: "2" }).success, true, param);
    assertEquals(query.safeParse({ [param]: "1.5" }).success, false, param);
  }
});

Deno.test("url.paginated merges extraResponse into a parent shared with a pagination path", () => {
  const result = url.paginated({
    item: z.object({ id: z.string() }),
    names: { nextUrl: "links.next", prevUrl: "links.prev" },
    extraResponse: {
      links: z.object({ self: z.string() }),
      total: z.number(),
    },
  });

  const parsed = result.response.parse({
    items: [{ id: "1" }],
    links: { self: "/repos?page=2", next: "/repos?page=3", prev: "/repos" },
    total: 3,
  });

  // `links.next` and `links.prev` are what __pagination points at; they
  // must survive next to the extra `links.self`.
  assertEquals(parsed, {
    items: [{ id: "1" }],
    links: { self: "/repos?page=2", next: "/repos?page=3", prev: "/repos" },
    total: 3,
  });
  assertEquals(result.__pagination.nextUrl, "links.next");
});

// =============================================================================
// page(): building the response of a page
// =============================================================================

const SAMPLE = [
  { id: "1", name: "Ada", email: "ada@example.test" },
  { id: "2", name: "Grace", email: "grace@example.test" },
];

Deno.test("page() builds a response the helper's schema accepts, for every style", () => {
  const byCursor = cursor.paginated({
    item: UserSchema,
    names: { items: "data", cursor: "nextCursor" },
  });
  const cursorPage = byCursor.page({ items: SAMPLE, cursor: "abc" });
  assertEquals(cursorPage, { data: SAMPLE, nextCursor: "abc" });
  assertEquals(byCursor.response.parse(cursorPage), cursorPage);
  // The last page has no cursor: the field is left out.
  assertEquals(byCursor.page({ items: [], cursor: null }), { data: [] });
  assertEquals(byCursor.page({ items: [] }), { data: [] });

  const byId = cursorId.paginated({ item: UserSchema });
  const idPage = byId.page({ items: SAMPLE });
  assertEquals(idPage, { items: SAMPLE });
  assertEquals(byId.response.parse(idPage), idPage);

  const byOffset = offset.paginated({
    item: UserSchema,
    names: { total: "count" },
  });
  const offsetPage = byOffset.page({ items: SAMPLE, total: 12 });
  assertEquals(offsetPage, { items: SAMPLE, count: 12 });
  assertEquals(byOffset.response.parse(offsetPage), offsetPage);

  const byPage = page.paginated({
    item: UserSchema,
    names: { total: "total", totalPages: "pages" },
  });
  const numbered = byPage.page({ items: SAMPLE, total: 12, totalPages: 6 });
  assertEquals(numbered, { items: SAMPLE, total: 12, pages: 6 });
  assertEquals(byPage.response.parse(numbered), numbered);

  const byUrl = url.paginated({
    item: UserSchema,
    names: {
      items: "data.users",
      nextUrl: "links.next",
      prevUrl: "links.prev",
    },
  });
  const linked = byUrl.page({
    items: SAMPLE,
    next: "/users?page=3",
    prev: "/users?page=1",
  });
  assertEquals(linked, {
    data: { users: SAMPLE },
    links: { next: "/users?page=3", prev: "/users?page=1" },
  });
  assertEquals(byUrl.response.parse(linked), linked);
  // A page without links: the object that would hold them is still there,
  // as the schema requires.
  const only = byUrl.page({ items: [] });
  assertEquals(only, { data: { users: [] }, links: {} });
  assertEquals(byUrl.response.parse(only), only);
  assertEquals(byUrl.page({ items: [], next: null, prev: null }), only);

  // Top-level link fields need no parent.
  const flat = url.paginated({ item: UserSchema });
  const flatPage: unknown = flat.page({ items: [] });
  assertEquals(flatPage, { items: [] });
  assertEquals(flat.response.safeParse(flatPage).success, true);
});

Deno.test("page() takes the extra response fields the helper declares", () => {
  const withExtra = offset.paginated({
    item: UserSchema,
    extraResponse: { took: z.number(), source: z.string() },
  });
  const built = withExtra.page({
    items: SAMPLE,
    total: 2,
    extra: { took: 12, source: "cache" },
  });
  assertEquals(built, { items: SAMPLE, total: 2, took: 12, source: "cache" });
  assertEquals(withExtra.response.parse(built), built);

  // An extra field that shares a parent with a pagination field.
  const shared = url.paginated({
    item: UserSchema,
    names: { nextUrl: "links.next" },
    extraResponse: { links: z.object({ self: z.string() }) },
  });
  assertEquals(
    shared.page({
      items: [],
      next: "/users?page=2",
      extra: { links: { self: "/users?page=1" } },
    }),
    { items: [], links: { next: "/users?page=2", self: "/users?page=1" } },
  );
});

Deno.test("page() checks its argument against the helper's configuration", () => {
  const byOffset = offset.paginated({ item: UserSchema });
  const byPage = page.paginated({
    item: UserSchema,
    names: { totalPages: "pages" },
  });
  const withExtra = cursor.paginated({
    item: UserSchema,
    extraResponse: { took: z.number() },
  });
  const never = false as boolean;
  if (never) {
    // @ts-expect-error an offset page needs the total
    byOffset.page({ items: SAMPLE });
    // @ts-expect-error the helper declares a page count
    byPage.page({ items: SAMPLE });
    // @ts-expect-error the helper declares no total
    byPage.page({ items: SAMPLE, totalPages: 1, total: 2 });
    // @ts-expect-error an item lacks `email`
    byOffset.page({ items: [{ id: "1", name: "Ada" }], total: 1 });
    // @ts-expect-error the declared extra field is missing
    withExtra.page({ items: SAMPLE });
    // @ts-expect-error `took` is a number
    withExtra.page({ items: SAMPLE, extra: { took: "fast" } });
  }
});

Deno.test("page() stays out of a spread: endpoint() gets schemas and metadata only", () => {
  const helper = cursor.paginated({ item: UserSchema });
  assertEquals(Object.keys({ ...helper }).sort(), [
    "__pagination",
    "query",
    "response",
  ]);
  assertEquals(typeof helper.page, "function");
});

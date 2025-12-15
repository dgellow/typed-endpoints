// Type-level test to verify pagination types work with endpoint()
// Run with: deno check src/pagination/types_test.ts

import { z } from "zod";
import { cursor, cursorId, offset, page } from "./index.ts";

const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
});

// Test 1: cursor.paginated generates correct query schema types
const cursorDef = cursor.paginated({
  item: UserSchema,
  names: {
    items: "data",
    cursor: "nextCursor",
    cursorParam: "after",
    limitParam: "size",
  },
  extraQuery: {
    filter: z.string().optional(),
  },
  extraResponse: {
    cached: z.boolean(),
  },
});

// Query schema should have typed fields
type CursorQuery = z.infer<typeof cursorDef.query>;
const _cq: CursorQuery = { after: "abc", size: 10, filter: "test" };
_cq.after satisfies string | undefined;
_cq.size satisfies number;
_cq.filter satisfies string | undefined;

// Response schema should have typed fields
type CursorResponse = z.infer<typeof cursorDef.response>;
const _cr: CursorResponse = {
  data: [{ id: "1", name: "Test", email: "test@example.com" }],
  nextCursor: "abc",
  cached: true,
};
_cr.data satisfies Array<{ id: string; name: string; email: string }>;
_cr.nextCursor satisfies string | undefined;
_cr.cached satisfies boolean;

// Test 2: offset.paginated generates correct types
const offsetDef = offset.paginated({
  item: UserSchema,
  names: {
    items: "results",
    total: "count",
    offsetParam: "skip",
    limitParam: "take",
  },
});

type OffsetQuery = z.infer<typeof offsetDef.query>;
const _oq: OffsetQuery = { skip: 0, take: 20 };
_oq.skip satisfies number;
_oq.take satisfies number;

type OffsetResponse = z.infer<typeof offsetDef.response>;
const _or: OffsetResponse = {
  results: [{ id: "1", name: "Test", email: "test@example.com" }],
  count: 100,
};
_or.results satisfies Array<{ id: string; name: string; email: string }>;
_or.count satisfies number;

// Test 3: page.paginated generates correct types
const pageDef = page.paginated({
  item: UserSchema,
  names: {
    items: "users",
    totalPages: "pages",
  },
});

type PageQuery = z.infer<typeof pageDef.query>;
const _pq: PageQuery = { page: 1, perPage: 20 };
_pq.page satisfies number;
_pq.perPage satisfies number;

type PageResponse = z.infer<typeof pageDef.response>;
const _pr: PageResponse = {
  users: [{ id: "1", name: "Test", email: "test@example.com" }],
  pages: 10,
};
_pr.users satisfies Array<{ id: string; name: string; email: string }>;
_pr.pages satisfies number;

// Test 4: cursorId.paginated generates correct types
const cursorIdDef = cursorId.paginated({
  item: UserSchema,
  names: {
    items: "data",
    cursorIdParam: "after",
    idField: "id",
  },
});

type CursorIdQuery = z.infer<typeof cursorIdDef.query>;
const _ciq: CursorIdQuery = { after: "abc", limit: 20 };
_ciq.after satisfies string | undefined;
_ciq.limit satisfies number;

// Test 5: Verify __pagination metadata is present and typed
cursorDef.__pagination.style satisfies "cursor";
cursorDef.__pagination.items satisfies string;
cursorDef.__pagination.cursor satisfies string;
cursorDef.__pagination.cursorParam satisfies string;

offsetDef.__pagination.style satisfies "offset";
offsetDef.__pagination.total satisfies string;

pageDef.__pagination.style satisfies "page";

cursorIdDef.__pagination.style satisfies "cursorId";
cursorIdDef.__pagination.idField satisfies string;

// =============================================================================
// PathToObject type utility tests
// =============================================================================

import type { MergeDeep, PathToObject, PathValue } from "./types.ts";

// Test 6: PathToObject - single segment (no dots)
type Single = PathToObject<"items", number[]>;
const _single: Single = { items: [1, 2, 3] };
_single.items satisfies number[];

// Test 7: PathToObject - two segments
type TwoSegments = PathToObject<"links.next", string>;
const _twoSeg: TwoSegments = { links: { next: "http://example.com" } };
_twoSeg.links.next satisfies string;

// Test 8: PathToObject - three segments
type ThreeSegments = PathToObject<"meta.pagination.cursor", string>;
const _threeSeg: ThreeSegments = {
  meta: { pagination: { cursor: "abc123" } },
};
_threeSeg.meta.pagination.cursor satisfies string;

// Test 9: PathToObject - with complex value type
type ComplexValue = PathToObject<"data.users", Array<{ id: string }>>;
const _complex: ComplexValue = { data: { users: [{ id: "1" }] } };
_complex.data.users[0].id satisfies string;

// Test 10: MergeDeep - merge flat objects
type MergedFlat = MergeDeep<{ a: string }, { b: number }>;
const _mergedFlat: MergedFlat = { a: "hello", b: 42 };
_mergedFlat.a satisfies string;
_mergedFlat.b satisfies number;

// Test 11: MergeDeep - merge nested objects with same parent
type MergedNested = MergeDeep<
  { links: { next: string } },
  { links: { prev: string } }
>;
const _mergedNested: MergedNested = {
  links: { next: "http://next", prev: "http://prev" },
};
_mergedNested.links.next satisfies string;
_mergedNested.links.prev satisfies string;

// Test 12: MergeDeep - merge multiple PathToObject results
type Items = PathToObject<"data.items", string[]>;
type Cursor = PathToObject<"data.cursor", string | undefined>;
type MergedPaths = MergeDeep<Items, Cursor>;
const _mergedPaths: MergedPaths = {
  data: { items: ["a", "b"], cursor: "xyz" },
};
_mergedPaths.data.items satisfies string[];
_mergedPaths.data.cursor satisfies string | undefined;

// Test 13: PathValue - extract from nested object
type NestedObj = { links: { next: string; prev: string }; data: number[] };
type NextValue = PathValue<NestedObj, "links.next">;
const _nextVal: NextValue = "http://example.com";
_nextVal satisfies string;

// Test 14: PathValue - single key access
type DataValue = PathValue<NestedObj, "data">;
const _dataVal: DataValue = [1, 2, 3];
_dataVal satisfies number[];

// Test 15: PathValue - deeply nested
type DeepObj = { a: { b: { c: { d: boolean } } } };
type DeepValue = PathValue<DeepObj, "a.b.c.d">;
const _deepVal: DeepValue = true;
_deepVal satisfies boolean;

// =============================================================================
// url.paginated with dot-notation paths - type tests
// =============================================================================

import { url } from "./index.ts";

// Test 16: url.paginated with flat paths (no dots)
const urlFlatDef = url.paginated({
  item: UserSchema,
  names: {
    items: "data",
    nextUrl: "next",
  },
});

type UrlFlatResponse = z.infer<typeof urlFlatDef.response>;
const _urlFlat: UrlFlatResponse = {
  data: [{ id: "1", name: "Test", email: "test@example.com" }],
  next: "http://example.com/next",
};
_urlFlat.data satisfies Array<{ id: string; name: string; email: string }>;
_urlFlat.next satisfies string | undefined;

// Test 17: url.paginated with nested paths (dots)
const urlNestedDef = url.paginated({
  item: UserSchema,
  names: {
    items: "data",
    nextUrl: "links.next",
    prevUrl: "links.prev",
  },
});

type UrlNestedResponse = z.infer<typeof urlNestedDef.response>;
const _urlNested: UrlNestedResponse = {
  data: [{ id: "1", name: "Test", email: "test@example.com" }],
  links: {
    next: "http://example.com/next",
    prev: "http://example.com/prev",
  },
};
_urlNested.data satisfies Array<{ id: string; name: string; email: string }>;
_urlNested.links.next satisfies string | undefined;
_urlNested.links.prev satisfies string | undefined;

// Test 18: url.paginated with deeply nested items path
const urlDeepDef = url.paginated({
  item: z.object({ id: z.string() }),
  names: {
    items: "response.body.items",
    nextUrl: "response.pagination.next",
  },
});

type UrlDeepResponse = z.infer<typeof urlDeepDef.response>;
const _urlDeep: UrlDeepResponse = {
  response: {
    body: {
      items: [{ id: "1" }],
    },
    pagination: {
      next: "http://example.com/next",
    },
  },
};
_urlDeep.response.body.items[0].id satisfies string;
_urlDeep.response.pagination.next satisfies string | undefined;

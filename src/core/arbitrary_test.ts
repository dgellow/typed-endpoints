import { assertEquals, assertNotEquals, assertThrows } from "@std/assert";
import { z } from "zod";

import { arbitrary, ArbitraryError, seededRandom } from "./arbitrary.ts";
import {
  AuthorizeRequestSchema,
  ExchangeResponseSchema,
  OAuthErrorSchema,
} from "../protocol/oauth.ts";
import { cursor, page } from "../pagination/index.ts";

/** `arbitrary()` parses what it returns; this draws many values. */
function sample<T extends z.ZodType>(schema: T, count = 200): z.input<T>[] {
  return Array.from(
    { length: count },
    (_, seed) => arbitrary(schema, { seed }),
  );
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const JsonSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(JsonSchema),
    z.record(z.string(), JsonSchema),
  ])
);

interface Tree {
  value: number;
  children: Tree[];
}
const TreeSchema: z.ZodType<Tree> = z.object({
  value: z.number(),
  get children() {
    return z.array(TreeSchema);
  },
});

const SCHEMAS: Record<string, z.ZodType> = {
  string: z.string(),
  "string min/max": z.string().min(2).max(5),
  "string length": z.string().length(4),
  "string min above the default length": z.string().min(40),
  "string starts/ends/includes": z.string().startsWith("ab").endsWith("z")
    .includes("mm"),
  "string uppercase": z.string().uppercase().min(3),
  "string lowercase": z.string().lowercase(),
  "string trimmed": z.string().trim().min(1),
  email: z.email(),
  "string().email()": z.string().email(),
  uuid: z.uuid(),
  uuidv4: z.uuidv4(),
  url: z.url(),
  "iso datetime": z.iso.datetime(),
  "iso date": z.iso.date(),
  "iso time": z.iso.time(),
  ipv4: z.ipv4(),
  ipv6: z.ipv6(),
  base64: z.base64(),
  base64url: z.base64url(),
  nanoid: z.nanoid(),
  ulid: z.ulid(),
  cuid: z.cuid(),
  cuid2: z.cuid2(),
  e164: z.e164(),
  hex: z.hex(),
  number: z.number(),
  int: z.number().int().min(1).max(100),
  "z.int()": z.int(),
  "z.int32()": z.int32(),
  "z.uint32()": z.uint32(),
  "open interval": z.number().gt(0).lt(1),
  "narrow open interval of integers": z.number().int().gt(4).lt(6),
  positive: z.number().positive(),
  nonnegative: z.number().int().nonnegative(),
  negative: z.number().negative(),
  "min only, above the default range": z.number().min(5000),
  "max only, below the default range": z.number().max(-5000),
  multipleOf: z.number().multipleOf(5).min(10).max(40),
  "coerced number with default": z.coerce.number().int().min(1).max(100)
    .default(20),
  bigint: z.bigint(),
  boolean: z.boolean(),
  null: z.null(),
  undefined: z.undefined(),
  nan: z.nan(),
  date: z.date(),
  "date range": z.date().min(new Date("2020-01-01")).max(
    new Date("2020-12-31"),
  ),
  any: z.any(),
  unknown: z.unknown(),
  literal: z.literal("a"),
  "literal list": z.literal(["a", "b", 3]),
  enum: z.enum(["x", "y", "z"]),
  "native enum": z.enum({ Up: "UP", Down: "DOWN" }),
  "template literal": z.templateLiteral(["id-", z.number().int().min(0)]),
  optional: z.string().optional(),
  nullable: z.string().nullable(),
  nullish: z.string().nullish(),
  default: z.string().default("x"),
  nonoptional: z.string().optional().nonoptional(),
  readonly: z.array(z.string()).readonly(),
  catch: z.number().catch(0),
  array: z.array(z.string()),
  "array min/max": z.array(z.number()).min(2).max(3),
  "array length": z.array(z.boolean()).length(5),
  nonempty: z.array(z.string()).nonempty(),
  set: z.set(z.number().int().min(0).max(1000)).min(1),
  map: z.map(z.string(), z.number()),
  tuple: z.tuple([z.string(), z.number()]),
  "tuple with rest": z.tuple([z.string()]).rest(z.boolean()),
  object: z.object({ a: z.string(), b: z.number().optional() }),
  "strict object": z.strictObject({ a: z.string(), b: z.boolean() }),
  "loose object": z.looseObject({ a: z.string() }),
  "nested object": z.object({
    user: z.object({ name: z.string().min(1), tags: z.array(z.string()) }),
  }),
  record: z.record(z.string(), z.number()),
  "record over an enum": z.record(z.enum(["a", "b"]), z.number()),
  "partial record": z.partialRecord(z.enum(["a", "b"]), z.number()),
  union: z.union([z.string(), z.number(), z.boolean()]),
  "discriminated union": z.discriminatedUnion("type", [
    z.object({ type: z.literal("ok"), value: z.number() }),
    z.object({ type: z.literal("error"), message: z.string() }),
  ]),
  intersection: z.intersection(
    z.object({ a: z.string() }),
    z.object({ b: z.number() }),
  ),
  transform: z.string().transform((s) => s.length),
  pipe: z.string().pipe(z.string().min(1)),
  preprocess: z.preprocess((v) => v, z.number().int()),
  stringbool: z.stringbool(),
  "refine the generator can satisfy by retrying": z.number().int().min(0)
    .max(100).refine((n) => n % 2 === 0),
  "regex the generator can satisfy by retrying": z.string().regex(/^[a-m]/),
  "recursive union (JSON)": JsonSchema,
  "recursive object (tree)": TreeSchema,
  "oauth authorize request": AuthorizeRequestSchema,
  "oauth error": OAuthErrorSchema,
  "oauth exchange response": ExchangeResponseSchema,
  "cursor pagination query": cursor.paginated({ item: z.string() }).query,
  "cursor pagination response": cursor.paginated({
    item: z.object({ id: z.uuid() }),
  }).response,
  "page pagination query": page.paginated({ item: z.string() }).query,
};

for (const [name, schema] of Object.entries(SCHEMAS)) {
  Deno.test(`arbitrary: ${name}`, () => {
    const values = sample(schema);
    // Every value was parsed by `arbitrary()`; parse once more here so the
    // test does not depend on that.
    for (const value of values) schema.parse(value);
  });
}

Deno.test("arbitrary: the same seed gives the same value", () => {
  const schema = SCHEMAS["oauth exchange response"];
  for (let seed = 0; seed < 20; seed++) {
    assertEquals(arbitrary(schema, { seed }), arbitrary(schema, { seed }));
  }
});

Deno.test("arbitrary: seeds cover the variants of a union", () => {
  const schema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("ok") }),
    z.object({ type: z.literal("error") }),
    z.object({ type: z.literal("pending") }),
  ]);
  const seen = new Set(sample(schema, 50).map((value) => value.type));
  assertEquals([...seen].sort(), ["error", "ok", "pending"]);
});

Deno.test("arbitrary: optional fields are sometimes present, sometimes not", () => {
  const schema = z.object({ note: z.string().optional() });
  const values = sample(schema, 100);
  const present = values.filter((value) => "note" in value).length;
  assertNotEquals(present, 0);
  assertNotEquals(present, values.length);
});

Deno.test("arbitrary: a shared generator continues its sequence", () => {
  const random = seededRandom(7);
  const first = arbitrary(z.uuid(), { random });
  const second = arbitrary(z.uuid(), { random });
  assertNotEquals(first, second);

  const again = seededRandom(7);
  assertEquals(arbitrary(z.uuid(), { random: again }), first);
  assertEquals(arbitrary(z.uuid(), { random: again }), second);
});

Deno.test("arbitrary: bounds are respected at their edges", () => {
  const ints = sample(z.number().int().min(1).max(3), 100);
  assertEquals([...new Set(ints)].sort(), [1, 2, 3]);

  const lengths = sample(z.array(z.null()).min(2).max(3), 100)
    .map((list) => list.length);
  assertEquals([...new Set(lengths)].sort(), [2, 3]);
});

Deno.test("arbitrary: a recursive schema ends", () => {
  const depth = (tree: Tree): number =>
    1 + Math.max(0, ...tree.children.map(depth));
  for (const tree of sample(TreeSchema, 50) as Tree[]) {
    // maxDepth (4) bounds the nesting; each level adds an object and an
    // array, so the tree is at most a few levels deep.
    assertEquals(depth(tree) <= 4, true);
  }
});

Deno.test("arbitrary: what it cannot generate is reported with its path", () => {
  const never = assertThrows(
    () => arbitrary(z.object({ a: z.object({ b: z.never() }) })),
    ArbitraryError,
    "`never` has no value",
  );
  assertEquals(never.path, "a.b");

  const custom = assertThrows(
    () => arbitrary(z.object({ file: z.custom<string>(() => true) })),
    ArbitraryError,
    'no generator for schema type "custom"',
  );
  assertEquals(custom.path, "file");

  // A refinement nothing the generator writes can pass.
  assertThrows(
    () => arbitrary(z.string().refine((s) => s === "\u0000"), { attempts: 10 }),
    ArbitraryError,
    "no accepted value in 10 attempts",
  );
});

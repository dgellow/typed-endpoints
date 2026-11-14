import { assertEquals } from "@std/assert";
import { z } from "zod";
import { lookupPath } from "./introspect.ts";

const out = (schema: unknown, path: string) =>
  lookupPath(schema, path === "" ? [] : path.split("."), "output");
const inp = (schema: unknown, path: string) =>
  lookupPath(schema, path === "" ? [] : path.split("."), "input");

Deno.test("lookupPath: the empty path is the schema itself", () => {
  assertEquals(out(z.string(), ""), "found");
});

Deno.test("lookupPath: object keys, nested", () => {
  const schema = z.object({ data: z.object({ token: z.string() }) });
  assertEquals(out(schema, "data"), "found");
  assertEquals(out(schema, "data.token"), "found");
  assertEquals(out(schema, "data.missing"), "missing");
  assertEquals(out(schema, "nope"), "missing");
});

Deno.test("lookupPath: nothing lies below a primitive", () => {
  const schema = z.object({ id: z.string(), n: z.number(), e: z.enum(["a"]) });
  assertEquals(out(schema, "id.length"), "missing");
  assertEquals(out(schema, "n.x"), "missing");
  assertEquals(out(schema, "e.x"), "missing");
});

Deno.test("lookupPath: wrappers are transparent", () => {
  const inner = z.object({ a: z.string() });
  for (
    const schema of [
      inner.optional(),
      inner.nullable(),
      inner.default({ a: "" }),
      inner.prefault({ a: "" }),
      inner.catch({ a: "" }),
      inner.readonly(),
      inner.optional().nonoptional(),
      inner.nullable().optional(),
    ]
  ) {
    assertEquals(out(schema, "a"), "found");
    assertEquals(out(schema, "b"), "missing");
  }
});

Deno.test("lookupPath: keys outside the shape depend on the catchall", () => {
  assertEquals(out(z.object({ a: z.string() }), "b"), "missing");
  assertEquals(out(z.strictObject({ a: z.string() }), "b"), "missing");
  assertEquals(out(z.looseObject({ a: z.string() }), "b"), "unknown");
  assertEquals(
    out(z.object({ a: z.string() }).catchall(z.number()), "b"),
    "unknown",
  );
});

Deno.test("lookupPath: a union has the path if one member has it", () => {
  const schema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("success"), code: z.string() }),
    z.object({ type: z.literal("error"), error: z.string() }),
  ]);
  assertEquals(out(schema, "type"), "found");
  assertEquals(out(schema, "code"), "found");
  assertEquals(out(schema, "error"), "found");
  assertEquals(out(schema, "other"), "missing");
});

Deno.test("lookupPath: a union with an open member is unknown, not missing", () => {
  const schema = z.union([
    z.object({ a: z.string() }),
    z.record(z.string(), z.string()),
  ]);
  assertEquals(out(schema, "a"), "found");
  assertEquals(out(schema, "b"), "unknown");
});

Deno.test("lookupPath: an intersection has the keys of both sides", () => {
  const schema = z.intersection(
    z.object({ a: z.string() }),
    z.object({ b: z.object({ c: z.number() }) }),
  );
  assertEquals(out(schema, "a"), "found");
  assertEquals(out(schema, "b.c"), "found");
  assertEquals(out(schema, "d"), "missing");
});

Deno.test("lookupPath: arrays are indexed by number", () => {
  const schema = z.object({ items: z.array(z.object({ id: z.string() })) });
  assertEquals(out(schema, "items.0"), "found");
  assertEquals(out(schema, "items.0.id"), "found");
  assertEquals(out(schema, "items.12.id"), "found");
  assertEquals(out(schema, "items.0.nope"), "missing");
  assertEquals(out(schema, "items.id"), "missing");
  assertEquals(out(schema, "items.length"), "missing");
});

Deno.test("lookupPath: tuples know their positions and their rest", () => {
  const fixed = z.tuple([z.string(), z.object({ a: z.number() })]);
  assertEquals(out(fixed, "0"), "found");
  assertEquals(out(fixed, "1.a"), "found");
  assertEquals(out(fixed, "2"), "missing");
  assertEquals(out(fixed, "first"), "missing");

  const withRest = z.tuple([z.string()], z.object({ a: z.number() }));
  assertEquals(out(withRest, "5.a"), "found");
  assertEquals(out(withRest, "5.b"), "missing");
});

Deno.test("lookupPath: schemas that do not describe their keys are unknown", () => {
  for (
    const schema of [
      z.any(),
      z.unknown(),
      z.record(z.string(), z.number()),
      z.map(z.string(), z.number()),
      z.custom<{ a: string }>(),
    ]
  ) {
    assertEquals(out(schema, "a"), "unknown");
  }
});

Deno.test("lookupPath: a pipe is read from the side that was asked for", () => {
  const schema = z.object({ raw: z.string() }).pipe(
    z.object({ raw: z.string(), parsed: z.number().optional() }),
  );
  assertEquals(inp(schema, "raw"), "found");
  assertEquals(inp(schema, "parsed"), "missing");
  assertEquals(out(schema, "parsed"), "found");
});

Deno.test("lookupPath: the output of a transform is unknown", () => {
  const schema = z.object({ a: z.string() }).transform((v) => ({ b: v.a }));
  assertEquals(inp(schema, "a"), "found");
  assertEquals(inp(schema, "b"), "missing");
  assertEquals(out(schema, "b"), "unknown");
  assertEquals(out(schema, "a"), "unknown");
});

Deno.test("lookupPath: lazy and recursive schemas", () => {
  const lazy = z.lazy(() => z.object({ a: z.string() }));
  assertEquals(out(lazy, "a"), "found");
  assertEquals(out(lazy, "b"), "missing");

  const Category = z.object({
    name: z.string(),
    get children() {
      return z.array(Category);
    },
  });
  assertEquals(out(Category, "children.0.children.0.name"), "found");
  assertEquals(out(Category, "children.0.children.0.nope"), "missing");
});

Deno.test("lookupPath: a value that is not a schema is unknown", () => {
  assertEquals(out(undefined, "a"), "unknown");
  assertEquals(out({}, "a"), "unknown");
});

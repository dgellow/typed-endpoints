/**
 * A contract's schema as a Python dict.
 *
 * These tests compare text. That the dict is what the generated module's
 * checker reads is established by `./scripts/test-python`.
 */

import { assertEquals } from "@std/assert";
import { z } from "zod";

import type { JsonSchema } from "../contract/index.ts";
import { PythonModels } from "./models.ts";
import { schemaLiteral } from "./schema.ts";

/** The dict of the JSON Schema a contract carries for a request part. */
function literal(schema: z.ZodType): string {
  // deno-lint-ignore no-explicit-any
  const json: JsonSchema = (schema as any)["~standard"].jsonSchema.input({
    target: "draft-2020-12",
    libraryOptions: { unrepresentable: "any" },
  });
  return schemaLiteral(json, new PythonModels());
}

Deno.test("python schema: a schema is the contract's, without its dialect", () => {
  assertEquals(
    literal(z.object({ title: z.string().min(1), pinned: z.boolean() })),
    '{"type": "object", "properties": {"title": {"type": "string", "minLength": 1}, ' +
      '"pinned": {"type": "boolean"}}, "required": ["title", "pinned"]}',
  );
  // What JSON writes otherwise than Python.
  assertEquals(
    literal(z.object({ note: z.string().nullable().default(null) }).strict()),
    '{"type": "object", "properties": {"note": {"default": None, "type": ' +
      '["string", "null"]}}, "additionalProperties": False}',
  );
});

Deno.test("python schema: a member named as a keyword is a member", () => {
  // `pattern` and `$schema` are names of members here, not keywords.
  assertEquals(
    literal(z.object({ pattern: z.string(), $schema: z.number() })),
    '{"type": "object", "properties": {"pattern": {"type": "string"}, ' +
      '"$schema": {"type": "number"}}, "required": ["pattern", "$schema"]}',
  );
});

Deno.test("python schema: a pattern is JavaScript's, short in place and long by name", () => {
  const models = new PythonModels();
  const schema = z.object({ code: z.string().regex(/^\d+$/), id: z.uuid() });
  // deno-lint-ignore no-explicit-any
  const json = (schema as any)["~standard"].jsonSchema.input({
    target: "draft-2020-12",
  });
  assertEquals(
    schemaLiteral(json, models),
    '{"type": "object", "properties": {"code": {"type": "string", "pattern": r"^\\d+$"}, ' +
      '"id": {"type": "string", "format": "uuid", "pattern": _UUID_PATTERN}}, ' +
      '"required": ["code", "id"]}',
  );
  // The models define the constant, and a model with that pattern uses it.
  const source = models.render().join("\n");
  assertEquals(source.includes("\n_UUID_PATTERN = (\n"), true);
});

Deno.test("python schema: a union told apart by one member names it", () => {
  const shape = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("circle"), radius: z.number() }),
    z.object({ kind: z.literal("rect"), width: z.number() }),
  ]);
  const text = literal(z.object({ shape }));
  assertEquals(
    text.includes('"discriminator": {"propertyName": "kind"}'),
    true,
    text,
  );
  // A union that no member decides has none.
  const loose = literal(z.object({ loose: z.union([z.string(), z.number()]) }));
  assertEquals(loose.includes("discriminator"), false, loose);
});

Deno.test("python schema: a schema that refers to itself keeps its references", () => {
  const tree: z.ZodType = z.object({
    name: z.string(),
    get children() {
      return z.array(tree);
    },
  });
  assertEquals(
    literal(tree),
    '{"type": "object", "properties": {"name": {"type": "string"}, "children": ' +
      '{"type": "array", "items": {"$ref": "#"}}}, "required": ["name", "children"]}',
  );
});

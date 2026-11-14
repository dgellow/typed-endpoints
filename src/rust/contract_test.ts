/**
 * A contract as Rust data, case by case.
 *
 * These tests compare text. That the text compiles and that the runtime
 * reads it as the schema it came from is established by
 * `./scripts/test-rust`.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { z } from "zod";

import type { JsonSchema } from "../contract/index.ts";
import {
  RustContract,
  rustFloat,
  rustInteger,
  rustString,
} from "./contract.ts";

/** The JSON Schema a contract carries for a Zod schema. */
function jsonSchema(
  schema: z.ZodType,
  io: "input" | "output" = "input",
): JsonSchema {
  // deno-lint-ignore no-explicit-any
  return (schema as any)["~standard"].jsonSchema[io]({
    target: "draft-2020-12",
    libraryOptions: { unrepresentable: "any" },
  });
}

/** The statics a schema becomes, without the module around them. */
function statics(
  schema: z.ZodType,
  io: "input" | "output" = "input",
): string {
  const data = new RustContract();
  data.define("THING", jsonSchema(schema, io));
  return data.render().slice(6, -1).join("\n");
}

Deno.test("rust contract: a schema is a static that sets the keywords it has", () => {
  assertEquals(
    statics(z.object({
      title: z.string().min(1).max(40),
      pinned: z.boolean().optional(),
      ratio: z.number().gt(0).multipleOf(0.25),
    })),
    `    pub(super) static THING: Schema = Schema {
        types: &[Type::Object],
        properties: Some(&[
            ("title", Schema {
                types: &[Type::String],
                min_length: Some(1),
                max_length: Some(40),
                ..Schema::ANY
            }),
            ("pinned", Schema { types: &[Type::Boolean], ..Schema::ANY }),
            ("ratio", Schema {
                types: &[Type::Number],
                exclusive_minimum: Some(0.0),
                multiple_of: Some(0.25),
                ..Schema::ANY
            }),
        ]),
        required: &["title", "ratio"],
        ..Schema::ANY
    };`,
  );
  // What says nothing accepts anything.
  assertEquals(
    statics(z.unknown()),
    "    pub(super) static THING: Schema = Schema::ANY;",
  );
});

Deno.test("rust contract: constants, options, alternatives, lists, tuples and records", () => {
  const text = statics(z.strictObject({
    kind: z.literal("note"),
    unit: z.enum(["mm", "cm"]),
    level: z.literal(2),
    when: z.string().nullable(),
    either: z.union([z.string(), z.object({ id: z.string() })]),
    tags: z.array(z.string()).max(4),
    pair: z.tuple([z.string(), z.boolean()]),
    scores: z.record(z.string(), z.boolean()),
  }));
  const has = (part: string) => assertEquals(text.includes(part), true, part);

  has('constant: Some(Literal::Text("note")),');
  has('options: Some(&[Literal::Text("mm"), Literal::Text("cm")]),');
  has("constant: Some(Literal::Number(2.0)),");
  // Nullable is a second type; a union is a list of alternatives.
  has(
    '("when", Schema { types: &[Type::String, Type::Null], ..Schema::ANY }),',
  );
  has(`any_of: Some(&[
                    Schema { types: &[Type::String], ..Schema::ANY },
                    Schema {`);
  has("items: Some(&Schema { types: &[Type::String], ..Schema::ANY }),");
  has(`prefix_items: Some(&[
                    Schema { types: &[Type::String], ..Schema::ANY },
                    Schema { types: &[Type::Boolean], ..Schema::ANY },
                ]),`);
  has(
    "additional: Additional::Each(&Schema { types: &[Type::Boolean], ..Schema::ANY }),",
  );
  // A closed object refuses the members it does not name.
  has(
    "        additional: Additional::Refused,\n        ..Schema::ANY\n    };",
  );
});

Deno.test("rust contract: a union says which member decides its alternative, if one does", () => {
  const circle = z.object({ kind: z.literal("circle"), radius: z.number() });
  const square = z.object({ kind: z.literal("square"), side: z.number() });
  const tagged = (schema: z.ZodType) =>
    statics(schema).split("\n").filter((line) => line.includes("tag:")).map(
      (line) => line.trim(),
    );

  // Every alternative is an object with a constant of its own there.
  assertEquals(tagged(z.discriminatedUnion("kind", [circle, square])), [
    'tag: Some("kind"),',
  ]);
  // Found by what the alternatives are, not by how the union was written.
  assertEquals(tagged(z.union([circle, square])), ['tag: Some("kind"),']);

  // An alternative that is not an object cannot be told by a member.
  assertEquals(tagged(z.union([z.number(), circle, square])), []);
  // The same constant twice tells nothing apart.
  assertEquals(tagged(z.union([circle, circle.extend({ x: z.string() })])), []);
});

Deno.test("rust contract: each distinct pattern is a static, and the router's list names them all", () => {
  const data = new RustContract();
  assertEquals(data.hasPatterns, false);
  data.define(
    "THING",
    jsonSchema(z.object({
      first: z.string().regex(/^\d+$/),
      second: z.string().regex(/^\d+$/),
      word: z.string().regex(/^(?!admin)\w+$/),
    })),
  );
  assertEquals(data.hasPatterns, true);
  const lines = data.render().map((line) => line.trim());
  // The same text twice is one pattern, compiled once.
  assertEquals(
    lines.includes("use super::runtime::{Pattern, Schema, Type};"),
    true,
  );
  assertEquals(lines.filter((line) => line.includes("PATTERN")), [
    '("first", Schema { types: &[Type::String], pattern: Some(&PATTERN_1), ..Schema::ANY }),',
    '("second", Schema { types: &[Type::String], pattern: Some(&PATTERN_1), ..Schema::ANY }),',
    '("word", Schema { types: &[Type::String], pattern: Some(&PATTERN_2), ..Schema::ANY }),',
    "pub(super) static PATTERNS: &[&Pattern] = &[&PATTERN_1, &PATTERN_2];",
    'static PATTERN_1: Pattern = Pattern::new(r"^\\d+$");',
    'static PATTERN_2: Pattern = Pattern::new(r"^(?!admin)\\w+$");',
  ]);

  // Without a pattern there is no list, and the router compiles nothing.
  const plain = new RustContract();
  plain.define("THING", jsonSchema(z.object({ name: z.string() })));
  assertEquals(plain.render().some((line) => line.includes("PATTERN")), false);
});

Deno.test("rust contract: a reference is the address of a static, also to itself", () => {
  const Tree: z.ZodType = z.object({
    name: z.string(),
    get children() {
      return z.array(Tree);
    },
  });
  // As the root of its document.
  assertEquals(
    statics(Tree).split("\n").filter((line) => line.includes("&THING")),
    [
      '            ("children", Schema { types: &[Type::Array], items: Some(&THING), ..Schema::ANY }),',
    ],
  );

  // Inside another schema: a static of its own, named after the document.
  const data = new RustContract();
  data.define("FOREST", jsonSchema(z.object({ root: Tree, spare: Tree })));
  const lines = data.render();
  assertEquals(
    lines.filter((line) => /static|&FOREST/.test(line)).map((line) =>
      line.trim()
    ),
    [
      "pub(super) static FOREST: Schema = Schema {",
      '("root", Schema { reference: Some(&FOREST_SCHEMA0), ..Schema::ANY }),',
      '("spare", Schema { reference: Some(&FOREST_SCHEMA0), ..Schema::ANY }),',
      "pub(super) static FOREST_SCHEMA0: Schema = Schema {",
      '("children", Schema { types: &[Type::Array], items: Some(&FOREST_SCHEMA0), ..Schema::ANY }),',
    ],
  );

  assertThrows(
    () =>
      new RustContract().define("BROKEN", {
        type: "array",
        items: { $ref: "#/$defs/missing" },
      }),
    Error,
    "Unresolved reference #/$defs/missing",
  );
});

Deno.test("rust contract: the same schema twice is one static; operations name their parts", () => {
  const NotFound = z.object({ error: z.literal("not_found") });
  const data = new RustContract();
  const first = data.define("NOTES_RETRIEVE_ERROR_404", jsonSchema(NotFound));
  const second = data.define("NOTES_DELETE_ERROR_404", jsonSchema(NotFound));
  assertEquals([first, second], [
    "NOTES_RETRIEVE_ERROR_404",
    "NOTES_RETRIEVE_ERROR_404",
  ]);

  const operation = data.operation("NOTES_RETRIEVE", {
    label: "GET /notes/{id}",
    response: "NOTE",
  });
  assertEquals(operation, "NOTES_RETRIEVE");
  const lines = data.render();
  assertEquals(lines.slice(0, 14), [
    "/// The contract as data: the operations, and the schemas the runtime",
    "/// checks their requests and responses against.",
    "#[rustfmt::skip]",
    "mod contract {",
    // Only what the statics name is imported.
    "    use super::runtime::{Literal, Operation, Schema, Type};",
    "",
    "    pub(super) static NOTES_RETRIEVE: Operation = Operation {",
    '        name: "GET /notes/{id}",',
    "        params: None,",
    "        query: None,",
    "        body: None,",
    "        response: Some(&NOTE),",
    "    };",
    "",
  ]);
  assertEquals(lines.filter((line) => line.includes("static ")).length, 2);
});

Deno.test("rust contract: literals as Rust writes them", () => {
  assertEquals(rustString("plain"), '"plain"');
  // A pattern keeps its backslashes: a raw string, with as many `#` as
  // it takes for the text not to end it.
  assertEquals(rustString("^\\d+$"), 'r"^\\d+$"');
  assertEquals(rustString('say "hi"'), 'r#"say "hi""#');
  assertEquals(rustString('a "# b'), 'r##"a "# b"##');
  // A raw string has no escapes, so a control character is not in one.
  assertEquals(rustString("tab\there"), '"tab\\there"');
  assertEquals(rustString('bell\u0007 "x"'), '"bell\\u{7} \\"x\\""');

  assertEquals(rustInteger(40), "40");
  assertEquals(rustInteger(-123456), "-123_456");
  assertEquals(rustFloat(1), "1.0");
  assertEquals(rustFloat(0.25), "0.25");
  assertEquals(rustFloat(-9007199254740991), "-9_007_199_254_740_991.0");
  assertEquals(rustFloat(1e21), "1e21");
  assertEquals(rustFloat(-1.5e-7), "-1.5e-7");
});

/**
 * The types of a contract as Rust source, case by case.
 *
 * These tests compare text. That the text is Rust that compiles, passes
 * clippy and reads and writes the same JSON as the TypeScript server is
 * established by `./scripts/test-rust`.
 */

import { assertEquals } from "@std/assert";
import { z } from "zod";

import type { JsonSchema } from "../contract/index.ts";
import { TypeGraph } from "../contract/types.ts";
import { constantCase, rawString, RustModels, snakeCase } from "./models.ts";

/** The JSON Schema a contract carries for a Zod schema. */
function jsonSchema(schema: z.ZodType, io: "input" | "output"): JsonSchema {
  // deno-lint-ignore no-explicit-any
  return (schema as any)["~standard"].jsonSchema[io]({
    target: "draft-2020-12",
    libraryOptions: { unrepresentable: "any" },
  });
}

/** The Rust type of a schema and the definitions it needs. */
function rust(
  schema: z.ZodType,
  options: { io?: "input" | "output"; name?: string } = {},
): { type: string; source: string } {
  const graph = new TypeGraph();
  const models = new RustModels(graph);
  const type = models.type(
    graph.define(
      options.name ?? "Thing",
      jsonSchema(schema, options.io ?? "input"),
      false,
    ),
  );
  return { type, source: models.render().join("\n").trimEnd() };
}

const DERIVE = "#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]";

Deno.test("rust models: plain types; what a type cannot say is left to the runtime", () => {
  const type = (schema: z.ZodType) => rust(schema).type;

  assertEquals(type(z.string()), "String");
  // A length, a pattern, a bound: not in the type.
  assertEquals(type(z.string().min(1).max(40).regex(/^\d+$/)), "String");
  assertEquals(type(z.boolean()), "bool");
  assertEquals(type(z.null()), "()");
  assertEquals(type(z.number().gt(0)), "f64");
  assertEquals(type(z.number().int().min(1)), "i64");
  assertEquals(type(z.unknown()), "Value");
  assertEquals(type(z.string().nullable()), "Option<String>");
});

Deno.test("rust models: lists, tuples and maps", () => {
  const type = (schema: z.ZodType) => rust(schema).type;

  assertEquals(type(z.array(z.string())), "Vec<String>");
  assertEquals(type(z.tuple([z.string(), z.number()])), "(String, f64)");
  assertEquals(type(z.tuple([z.string()])), "(String,)");
  assertEquals(
    type(z.record(z.string(), z.array(z.boolean()))),
    "BTreeMap<String, Vec<bool>>",
  );
});

Deno.test("rust models: a struct; required, nullable, optional and default fields", () => {
  const { type, source } = rust(
    z.object({
      id: z.string(),
      deleted: z.string().nullable(),
      nickname: z.string().optional(),
      note: z.string().nullable().optional(),
      role: z.string().default("member"),
      limit: z.number().int().nullable().default(null),
    }).describe("A person"),
    { name: "Person" },
  );
  assertEquals(type, "Person");
  assertEquals(
    source,
    `/// A person
${DERIVE}
pub struct Person {
    pub id: String,
    pub deleted: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nickname: Option<String>,
    #[serde(default, deserialize_with = "nullable_member", skip_serializing_if = "Option::is_none")]
    pub note: Option<Option<String>>,
    #[serde(default = "default_person_role")]
    pub role: String,
    #[serde(default = "default_person_limit")]
    pub limit: Option<i64>,
}

fn default_person_role() -> String {
    default_value(r#""member""#)
}
fn default_person_limit() -> Option<i64> {
    default_value(r#"null"#)
}`,
  );
});

Deno.test("rust models: once parsed, a default is a required field", () => {
  const { source } = rust(z.object({ role: z.string().default("member") }), {
    io: "output",
  });
  // What was parsed has no other members either.
  assertEquals(
    source,
    `${DERIVE}
#[serde(deny_unknown_fields)]
pub struct Thing {
    pub role: String,
}`,
  );
});

Deno.test("rust models: names Rust cannot use keep their wire name", () => {
  const { source } = rust(
    z.strictObject({
      type: z.string(),
      "data-id": z.string(),
      createdAt: z.string(),
      created_at: z.string(),
      "2fa": z.boolean(),
    }),
  );
  assertEquals(
    source,
    `${DERIVE}
#[serde(deny_unknown_fields)]
pub struct Thing {
    #[serde(rename = "type")]
    pub type_: String,
    #[serde(rename = "data-id")]
    pub data_id: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "created_at")]
    pub created_at_2: String,
    #[serde(rename = "2fa")]
    pub _2fa: bool,
}`,
  );
});

Deno.test("rust models: string literals are an enum; one value is its own default", () => {
  const { source } = rust(
    z.object({
      kind: z.literal("alarm"),
      level: z.enum(["low", "high", "very-high", "Low"]),
      // Not strings: the type they have.
      version: z.literal(2),
      on: z.literal(true),
    }),
    { name: "Alarm" },
  );
  assertEquals(
    source,
    `${DERIVE}
pub struct Alarm {
    pub kind: AlarmKind,
    pub level: AlarmLevel,
    pub version: i64,
    pub on: bool,
}

/// The value "alarm".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum AlarmKind {
    #[default]
    #[serde(rename = "alarm")]
    Alarm,
}

/// One of "low", "high", "very-high", "Low".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AlarmLevel {
    #[serde(rename = "low")]
    Low,
    #[serde(rename = "high")]
    High,
    #[serde(rename = "very-high")]
    VeryHigh,
    #[serde(rename = "Low")]
    Low2,
}`,
  );
});

Deno.test("rust models: the same literals in two places are one enum with two names", () => {
  const Level = z.enum(["low", "high"]);
  const graph = new TypeGraph();
  const models = new RustModels(graph);
  const first = models.type(
    graph.define(
      "Alarm",
      jsonSchema(z.object({ level: Level }), "input"),
      false,
    ),
  );
  const second = models.type(
    graph.define(
      "Filter",
      jsonSchema(z.object({ level: Level, text: z.string() }), "input"),
      false,
    ),
  );
  assertEquals([first, second], ["Alarm", "Filter"]);
  const source = models.render().join("\n");
  assertEquals(source.includes("pub level: AlarmLevel,"), true);
  assertEquals(source.includes("pub level: FilterLevel,"), true);
  assertEquals(source.includes("pub type FilterLevel = AlarmLevel;"), true);
  assertEquals(source.match(/pub enum /g)?.length, 1);
});

Deno.test("rust models: a union is an untagged enum, its variants named by what tells them apart", () => {
  const { type, source } = rust(
    z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("circle"), radius: z.number() }),
      z.object({ kind: z.literal("square"), side: z.number() }),
    ]),
    { name: "Shape" },
  );
  assertEquals(type, "Shape");
  assertEquals(
    source,
    `${DERIVE}
pub struct ShapeCircle {
    pub kind: ShapeCircleKind,
    pub radius: f64,
}

${DERIVE}
pub struct ShapeSquare {
    pub kind: ShapeSquareKind,
    pub side: f64,
}

/// One of 2 alternatives, told apart by \`kind\`.
${DERIVE}
#[serde(untagged)]
pub enum Shape {
    Circle(ShapeCircle),
    Square(ShapeSquare),
}

/// The value "circle".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum ShapeCircleKind {
    #[default]
    #[serde(rename = "circle")]
    Circle,
}

/// The value "square".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum ShapeSquareKind {
    #[default]
    #[serde(rename = "square")]
    Square,
}`,
  );
});

Deno.test("rust models: a union of plain types names its variants by type", () => {
  const { type, source } = rust(
    z.union([z.string(), z.number(), z.array(z.string()), z.string().max(3)]),
    { name: "Loose" },
  );
  assertEquals(type, "Loose");
  assertEquals(
    source,
    `/// One of 4 alternatives.
${DERIVE}
#[serde(untagged)]
pub enum Loose {
    Text(String),
    Number(f64),
    List(Vec<String>),
    Variant4(String),
}`,
  );

  // With null among them: an Option of the rest.
  assertEquals(
    rust(z.union([z.string(), z.number(), z.null()]), { name: "Loose" }).type,
    "Option<Loose>",
  );
});

Deno.test("rust models: a type that contains itself is boxed, except behind a Vec or a map", () => {
  const Tree: z.ZodType = z.object({
    label: z.string(),
    get children() {
      return z.array(Tree);
    },
    get named() {
      return z.record(z.string(), Tree);
    },
    get parent() {
      return Tree.optional();
    },
    get origin() {
      return Tree.nullable();
    },
  });
  assertEquals(
    rust(Tree, { name: "Tree" }).source,
    `${DERIVE}
pub struct Tree {
    pub label: String,
    pub children: Vec<Tree>,
    pub named: BTreeMap<String, Tree>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<Box<Tree>>,
    pub origin: Option<Box<Tree>>,
}`,
  );
});

Deno.test("rust models: a struct inside a union inside itself is boxed", () => {
  const Self: z.ZodType = z.object({
    name: z.string(),
    get either() {
      return z.union([Self, z.string()]);
    },
  });
  assertEquals(
    rust(Self, { name: "Node" }).source,
    `${DERIVE}
pub struct Node {
    pub name: String,
    pub either: NodeEither,
}

/// One of 2 alternatives.
${DERIVE}
#[serde(untagged)]
pub enum NodeEither {
    Variant1(Box<Node>),
    Text(String),
}`,
  );
});

Deno.test("rust models: a union that refers to itself is an enum of its own name", () => {
  type Json = string | null | Json[] | { [key: string]: Json };
  const Json: z.ZodType<Json> = z.union([
    z.string(),
    z.null(),
    z.array(z.lazy(() => Json)),
    z.record(z.string(), z.lazy(() => Json)),
  ]);
  const { type, source } = rust(
    z.object({ data: Json, more: Json.optional() }),
    { name: "Doc" },
  );
  assertEquals(type, "Doc");
  // Null is a variant, so an optional field of the type has to tell a
  // null that is there from a field that is not.
  assertEquals(
    source,
    `/// One of 4 alternatives.
${DERIVE}
#[serde(untagged)]
pub enum DocData {
    Text(String),
    Null,
    List(Vec<DocData>),
    Map(BTreeMap<String, DocData>),
}

${DERIVE}
pub struct Doc {
    pub data: DocData,
    #[serde(default, deserialize_with = "present_member", skip_serializing_if = "Option::is_none")]
    pub more: Option<DocData>,
}`,
  );
});

Deno.test("rust models: a union that refers to itself through a struct", () => {
  type Expr = number | { op: "neg"; of: Expr } | { op: "add"; args: Expr[] };
  const Expr: z.ZodType<Expr> = z.union([
    z.number(),
    z.object({
      op: z.literal("neg"),
      get of() {
        return Expr;
      },
    }),
    z.object({
      op: z.literal("add"),
      get args() {
        return z.array(Expr);
      },
    }),
  ]);
  const lines = rust(Expr, { name: "Expr" }).source.split("\n");
  assertEquals(
    lines.filter((line) => /Expr\b.*[,{]$|^pub (enum|struct)/.test(line)),
    [
      "pub struct Expr2 {",
      "    pub of: Box<Expr>,",
      "pub struct Expr3 {",
      "    pub args: Vec<Expr>,",
      "pub enum Expr {",
      "pub enum Expr2Op {",
      "pub enum Expr3Op {",
    ],
  );
});

Deno.test("rust models: the same object twice is one struct with two names", () => {
  const Money = z.object({ amount: z.number() });
  const graph = new TypeGraph();
  const models = new RustModels(graph);
  models.type(graph.define("Price", jsonSchema(Money, "input"), false));
  models.type(graph.define("Refund", jsonSchema(Money, "input"), false));
  assertEquals(
    models.render().join("\n").trimEnd(),
    `${DERIVE}
pub struct Price {
    pub amount: f64,
}

/// The same type as [\`Price\`].
pub type Refund = Price;`,
  );
});

Deno.test("rust models: descriptions become documentation", () => {
  const { source } = rust(
    z.object({
      id: z.string().describe("Where it is kept.\nNever reused."),
    }).describe("A note"),
  );
  assertEquals(
    source,
    `/// A note
${DERIVE}
pub struct Thing {
    /// Where it is kept.
    /// Never reused.
    pub id: String,
}`,
  );
});

Deno.test("rust models: names and literals", () => {
  assertEquals(snakeCase("usersRetrieve"), "users_retrieve");
  assertEquals(snakeCase("data-id"), "data_id");
  assertEquals(snakeCase("type"), "type_");
  assertEquals(snakeCase("2fa"), "_2fa");
  assertEquals(snakeCase("--"), "_");
  assertEquals(constantCase("usersRetrieve"), "USERS_RETRIEVE");
  assertEquals(constantCase("type"), "TYPE");

  assertEquals(rawString("plain"), 'r#"plain"#');
  // The text may hold what would end the literal.
  assertEquals(rawString('a "# b'), 'r##"a "# b"##');
  assertEquals(rawString('a "## b "# c'), 'r###"a "## b "# c"###');
});

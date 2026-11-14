/**
 * The types of a contract as Rust source, case by case.
 *
 * These tests compare text. That the text is Rust that compiles, is
 * formatted as rustfmt formats, has nothing for clippy to say and reads
 * and writes the same JSON as the TypeScript server is established by
 * `./scripts/test-rust`.
 */

import { assertEquals } from "@std/assert";
import { z } from "zod";

import type { JsonSchema } from "../contract/index.ts";
import { TypeGraph } from "../contract/types.ts";
import {
  constantCase,
  identifier,
  RustModels,
  snakeCase,
  wrapped,
} from "./models.ts";

/** The JSON Schema a contract carries for a Zod schema. */
function jsonSchema(schema: z.ZodType, io: "input" | "output"): JsonSchema {
  // deno-lint-ignore no-explicit-any
  return (schema as any)["~standard"].jsonSchema[io]({
    target: "draft-2020-12",
    libraryOptions: { unrepresentable: "any" },
  });
}

/** A graph and its models, as the axum module builds them. */
function models(): { graph: TypeGraph; models: RustModels } {
  const graph = new TypeGraph({ mergeSides: true });
  return { graph, models: new RustModels(graph) };
}

/** The Rust type of a schema and the definitions it needs. */
function rust(
  schema: z.ZodType,
  options: { io?: "input" | "output"; name?: string } = {},
): { type: string; source: string } {
  const { graph, models: rendered } = models();
  const type = rendered.type(
    graph.define(
      options.name ?? "Thing",
      jsonSchema(schema, options.io ?? "input"),
      false,
    ),
  );
  return { type, source: rendered.render().join("\n").trimEnd() };
}

const DERIVE = "#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]";
const DERIVE_EQ =
  "#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]";
const DERIVE_ENUM =
  "#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]";

Deno.test("rust models: plain types; what a type cannot say is left to the runtime", () => {
  const type = (schema: z.ZodType) => rust(schema).type;

  assertEquals(type(z.string()), "String");
  // A length, a pattern, a bound: not in the type.
  assertEquals(type(z.string().min(1).max(40).regex(/^\d+$/)), "String");
  assertEquals(type(z.boolean()), "bool");
  assertEquals(type(z.null()), "()");
  assertEquals(type(z.number().gt(0)), "f64");
  assertEquals(type(z.number().int()), "i64");
  // Except that an integer is not negative.
  assertEquals(type(z.number().int().min(0)), "u64");
  assertEquals(type(z.number().int().min(1).max(100)), "u64");
  assertEquals(type(z.number().int().gt(-1)), "u64");
  assertEquals(type(z.number().int().min(-5)), "i64");
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

Deno.test("rust models: a struct; required, nullable, optional and default members", () => {
  const { type, source } = rust(
    z.object({
      id: z.string(),
      deleted: z.string().nullable(),
      nickname: z.string().optional(),
      note: z.string().nullable().optional(),
      role: z.string().default("member"),
      limit: z.number().int().nullable().default(null),
      tags: z.array(z.string()).default(["a"]),
      ratio: z.number().default(0.5),
      seats: z.number().int().min(0).default(100000),
    }).describe("A person"),
    { name: "Person" },
  );
  assertEquals(type, "Person");
  // A default is an expression of the member's type.
  assertEquals(
    source,
    `/// A person
${DERIVE}
pub struct Person {
    pub id: String,
    pub deleted: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nickname: Option<String>,
    #[serde(default, skip_serializing_if = "MaybeAbsent::is_absent")]
    pub note: MaybeAbsent<String>,
    #[serde(default = "default_person_role")]
    pub role: String,
    #[serde(default = "default_person_limit")]
    pub limit: Option<i64>,
    #[serde(default = "default_person_tags")]
    pub tags: Vec<String>,
    #[serde(default = "default_person_ratio")]
    pub ratio: f64,
    #[serde(default = "default_person_seats")]
    pub seats: u64,
}

fn default_person_role() -> String {
    String::from("member")
}

fn default_person_limit() -> Option<i64> {
    None
}

fn default_person_tags() -> Vec<String> {
    vec![String::from("a")]
}

fn default_person_ratio() -> f64 {
    0.5
}

fn default_person_seats() -> u64 {
    100_000
}`,
  );
});

Deno.test("rust models: the type says which types it uses", () => {
  const { graph, models: rendered } = models();
  rendered.type(
    graph.define(
      "Thing",
      jsonSchema(z.object({ id: z.string() }), "input"),
      false,
    ),
  );
  rendered.render();
  assertEquals(
    [rendered.usesMaybeAbsent, rendered.usesMap, rendered.usesValue],
    [false, false, false],
  );

  const other = models();
  other.models.type(
    other.graph.define(
      "Thing",
      jsonSchema(
        z.object({
          note: z.string().nullable().optional(),
          scores: z.record(z.string(), z.number()),
          anything: z.unknown(),
        }),
        "input",
      ),
      false,
    ),
  );
  other.models.render();
  assertEquals(
    [
      other.models.usesMaybeAbsent,
      other.models.usesMap,
      other.models.usesValue,
    ],
    [true, true, true],
  );
});

Deno.test("rust models: a type with nothing that has to be given has a default", () => {
  // Every member absent.
  assertEquals(
    rust(
      z.object({ a: z.string().optional(), b: z.number().int().optional() }),
      { name: "Filter" },
    ).source,
    `#[derive(Debug, Clone, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
pub struct Filter {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub a: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub b: Option<i64>,
}`,
  );

  // Or at the default the contract gives it, which `derive` would not
  // know.
  assertEquals(
    rust(
      z.object({
        cursor: z.string().optional(),
        limit: z.number().int().min(1).default(20),
      }),
      { name: "Page" },
    ).source,
    `${DERIVE_EQ}
pub struct Page {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default = "default_page_limit")]
    pub limit: u64,
}

impl Default for Page {
    fn default() -> Self {
        Self {
            cursor: None,
            limit: default_page_limit(),
        }
    }
}

fn default_page_limit() -> u64 {
    20
}`,
  );
});

Deno.test("rust models: both sides of a schema are one type", () => {
  const Settings = z.strictObject({ theme: z.string().default("light") });
  const { graph, models: rendered } = models();
  const body = rendered.type(
    graph.define("Body", jsonSchema(Settings, "input"), false),
  );
  const response = rendered.type(
    graph.define("Response", jsonSchema(Settings, "output"), false),
  );
  assertEquals([body, response], ["Body", "Response"]);
  // Closed objects are not `deny_unknown_fields`: the runtime refuses the
  // members, and reports them with every other issue.
  assertEquals(
    rendered.render().join("\n").trimEnd(),
    `#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct Body {
    #[serde(default = "default_body_theme")]
    pub theme: String,
}

impl Default for Body {
    fn default() -> Self {
        Self {
            theme: default_body_theme(),
        }
    }
}

fn default_body_theme() -> String {
    String::from("light")
}

/// The same type as [\`Body\`].
pub type Response = Body;`,
  );
});

Deno.test("rust models: names Rust cannot use, and names a rule covers", () => {
  // A reserved word is a raw identifier, which serde reads as the word.
  assertEquals(
    rust(
      z.object({
        type: z.string(),
        "data-id": z.string(),
        createdAt: z.string(),
        created_at: z.string(),
        "2fa": z.boolean(),
        self: z.string(),
      }),
    ).source,
    `${DERIVE_EQ}
pub struct Thing {
    pub r#type: String,
    #[serde(rename = "data-id")]
    pub data_id: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "created_at")]
    pub created_at_2: String,
    #[serde(rename = "2fa")]
    pub field_2fa: bool,
    #[serde(rename = "self")]
    pub self_: String,
}`,
  );

  // When one rule gives the wire names, the struct says the rule.
  assertEquals(
    rust(
      z.object({
        createdAt: z.string(),
        updatedAt: z.string(),
        id: z.string(),
        created_at: z.string(),
      }),
    ).source,
    `${DERIVE_EQ}
#[serde(rename_all = "camelCase")]
pub struct Thing {
    pub created_at: String,
    pub updated_at: String,
    pub id: String,
    #[serde(rename = "created_at")]
    pub created_at_2: String,
}`,
  );
});

Deno.test("rust models: string literals are an enum; a rule names its values", () => {
  const { source } = rust(
    z.object({
      unit: z.enum(["mm", "cm"]).default("cm"),
      level: z.enum(["low", "very-high", "Low"]),
      state: z.enum(["ON", "OFF"]),
      phase: z.enum(["Start", "End"]),
      // Not strings: the type they have.
      version: z.literal(2),
      on: z.literal(true),
    }),
    { name: "Alarm" },
  );
  assertEquals(
    source,
    `${DERIVE_EQ}
pub struct Alarm {
    #[serde(default = "default_alarm_unit")]
    pub unit: AlarmUnit,
    pub level: AlarmLevel,
    pub state: AlarmState,
    pub phase: AlarmPhase,
    pub version: i64,
    pub on: bool,
}

fn default_alarm_unit() -> AlarmUnit {
    AlarmUnit::Cm
}

/// One of \`"mm"\`, \`"cm"\`.
${DERIVE_ENUM}
#[serde(rename_all = "lowercase")]
pub enum AlarmUnit {
    Mm,
    Cm,
}

/// One of \`"low"\`, \`"very-high"\`, \`"Low"\`.
${DERIVE_ENUM}
#[serde(rename_all = "kebab-case")]
pub enum AlarmLevel {
    Low,
    VeryHigh,
    #[serde(rename = "Low")]
    Low2,
}

/// One of \`"ON"\`, \`"OFF"\`.
${DERIVE_ENUM}
#[serde(rename_all = "UPPERCASE")]
pub enum AlarmState {
    On,
    Off,
}

/// One of \`"Start"\`, \`"End"\`.
${DERIVE_ENUM}
pub enum AlarmPhase {
    Start,
    End,
}`,
  );
});

Deno.test("rust models: serde writes a struct's constant, unless the struct is a variant", () => {
  // Alone: the constant is an attribute, and there is no field to fill in.
  assertEquals(
    rust(
      z.object({
        error: z.literal("not_found"),
        id: z.string(),
        // Only the first; a second constant is a field of one value.
        scope: z.literal("notes"),
      }),
      { name: "NotFound" },
    ).source,
    `${DERIVE_EQ}
#[serde(tag = "error", rename = "not_found")]
pub struct NotFound {
    pub id: String,
    pub scope: NotFoundScope,
}

/// The value \`"notes"\`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
pub enum NotFoundScope {
    #[default]
    #[serde(rename = "notes")]
    Notes,
}`,
  );

  // A constant that may be absent, or is not a string, stays a field.
  assertEquals(
    rust(z.object({ kind: z.literal("x").optional(), version: z.literal(2) }))
      .source.includes("tag ="),
    false,
  );

  // In a union without a deciding member, serde tells the variants apart
  // by reading them, and it does not read a struct's tag: measured, two
  // structs that differ in the constant only both read as the first. So
  // a variant keeps the constant as a field of a type with one value.
  const lines = rust(
    z.union([
      z.number(),
      z.object({ op: z.literal("neg"), of: z.number() }),
      z.object({ op: z.literal("abs"), of: z.number() }),
    ]),
    { name: "Expr" },
  ).source.split("\n");
  assertEquals(lines.some((line) => line.includes("tag =")), false);
  assertEquals(
    lines.filter((line) => line.includes("pub op:")),
    ["    pub op: ExprNegOp,", "    pub op: ExprAbsOp,"],
  );
});

Deno.test("rust models: the same literals in two places are one enum with two names", () => {
  const Level = z.enum(["low", "high"]);
  const { graph, models: rendered } = models();
  const first = rendered.type(
    graph.define(
      "Alarm",
      jsonSchema(z.object({ level: Level }), "input"),
      false,
    ),
  );
  const second = rendered.type(
    graph.define(
      "Filter",
      jsonSchema(z.object({ level: Level, text: z.string() }), "input"),
      false,
    ),
  );
  assertEquals([first, second], ["Alarm", "Filter"]);
  const source = rendered.render().join("\n");
  assertEquals(source.includes("pub level: AlarmLevel,"), true);
  assertEquals(source.includes("pub level: FilterLevel,"), true);
  assertEquals(source.includes("pub type FilterLevel = AlarmLevel;"), true);
  assertEquals(source.match(/pub enum /g)?.length, 1);
});

Deno.test("rust models: a union told apart by a member is an enum tagged by it", () => {
  const { type, source } = rust(
    z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("circle"), radius: z.number() }),
      z.object({ kind: z.literal("square"), side: z.number().int() }),
    ]),
    { name: "Shape" },
  );
  assertEquals(type, "Shape");
  // The enum reads the member, so the structs do not have it.
  assertEquals(
    source,
    `${DERIVE}
pub struct ShapeCircle {
    pub radius: f64,
}

${DERIVE_EQ}
pub struct ShapeSquare {
    pub side: i64,
}

/// One of 2 alternatives, told apart by \`kind\`.
${DERIVE}
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Shape {
    Circle(ShapeCircle),
    Square(ShapeSquare),
}`,
  );
});

Deno.test("rust models: a variant that is also used by itself keeps the member", () => {
  const Circle = z.object({ kind: z.literal("circle"), radius: z.number() });
  const Square = z.object({ kind: z.literal("square"), side: z.number() });
  const { source } = rust(
    z.object({
      shape: z.discriminatedUnion("kind", [Circle, Square]),
      // Without the enum around it, a circle has to say that it is one.
      last: Circle,
    }),
    { name: "Drawing" },
  );
  const lines = source.split("\n");
  assertEquals(
    lines.filter((line) => /kind|untagged|tag =|pub type/.test(line)),
    [
      "    pub kind: DrawingShapeCircleKind,",
      "    pub kind: DrawingShapeSquareKind,",
      "pub type DrawingLast = DrawingShapeCircle;",
      "#[serde(untagged)]",
    ],
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
    get either() {
      return z.union([Tree, z.string()]);
    },
  });
  assertEquals(
    rust(Tree, { name: "Tree" }).source,
    `${DERIVE_EQ}
pub struct Tree {
    pub label: String,
    pub children: Vec<Tree>,
    pub named: BTreeMap<String, Tree>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<Box<Tree>>,
    pub origin: Option<Box<Tree>>,
    pub either: TreeEither,
}

/// One of 2 alternatives.
${DERIVE_EQ}
#[serde(untagged)]
pub enum TreeEither {
    Variant1(Box<Tree>),
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
  // Null is a variant, so an optional member of the type has to tell a
  // null that is there from a member that is not.
  assertEquals(
    source,
    `/// One of 4 alternatives.
${DERIVE_EQ}
#[serde(untagged)]
pub enum DocData {
    Text(String),
    Null,
    List(Vec<DocData>),
    Map(BTreeMap<String, DocData>),
}

${DERIVE_EQ}
pub struct Doc {
    pub data: DocData,
    #[serde(
        default,
        deserialize_with = "runtime::present_member",
        skip_serializing_if = "Option::is_none"
    )]
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
  // The structs are named by the constant that tells them apart, and so
  // are their variants; a number beside them keeps the enum untagged.
  assertEquals(
    lines.filter((line) =>
      /Expr\b.*[,{]$|^pub (enum|struct)|^ {4}\w+\(|untagged/.test(line)
    ),
    [
      "pub struct ExprNeg {",
      "    pub of: Box<Expr>,",
      "pub struct ExprAdd {",
      "    pub args: Vec<Expr>,",
      "#[serde(untagged)]",
      "pub enum Expr {",
      "    Number(f64),",
      "    Neg(ExprNeg),",
      "    Add(ExprAdd),",
      "pub enum ExprNegOp {",
      "pub enum ExprAddOp {",
    ],
  );
});

Deno.test("rust models: descriptions become documentation", () => {
  const { graph, models: rendered } = models();
  const type = rendered.type(
    graph.define(
      "Note",
      jsonSchema(
        z.object({
          id: z.string().describe("Where it is kept.\nNever reused."),
        }),
        "input",
      ),
      false,
    ),
  );
  // A type without a description takes the one it is given.
  rendered.describe(type, "The body of `POST /notes`.");
  rendered.describe(type, "Not this one.");
  assertEquals(
    rendered.render().join("\n").trimEnd(),
    `/// The body of \`POST /notes\`.
${DERIVE_EQ}
pub struct Note {
    /// Where it is kept.
    /// Never reused.
    pub id: String,
}`,
  );

  assertEquals(
    rust(z.object({ id: z.string() }).describe("A note")).source.split("\n")[0],
    "/// A note",
  );
});

Deno.test("rust models: names, and lists that break when they are too long", () => {
  assertEquals(snakeCase("usersRetrieve"), "users_retrieve");
  assertEquals(snakeCase("data-id"), "data_id");
  assertEquals(snakeCase("2fa"), "_2fa");
  assertEquals(snakeCase("--"), "_");
  assertEquals(constantCase("usersRetrieve"), "USERS_RETRIEVE");
  assertEquals(identifier("type"), "r#type");
  assertEquals(identifier("name"), "name");
  // Words that cannot be raw identifiers.
  assertEquals(identifier("self"), "self_");
  assertEquals(identifier("crate"), "crate_");

  assertEquals(wrapped(4, "fn f(", ["&self", "a: A"], ") -> B;"), [
    "    fn f(&self, a: A) -> B;",
  ]);
  const long = "VeryLongTypeName".repeat(4);
  assertEquals(wrapped(4, "fn f(", ["&self", `a: ${long}`], `) -> ${long};`), [
    "    fn f(",
    "        &self,",
    `        a: ${long},`,
    `    ) -> ${long};`,
  ]);
  // An attribute has no comma after its last item.
  assertEquals(wrapped(0, "#[serde(", [long, long], ")]", false), [
    "#[serde(",
    `    ${long},`,
    `    ${long}`,
    ")]",
  ]);
});

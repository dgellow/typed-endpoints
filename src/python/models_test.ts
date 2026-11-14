/**
 * JSON Schema to Pydantic source, case by case.
 *
 * These tests compare text. That the text is Python that runs, validates
 * and type-checks is established by `./scripts/test-python`.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { z } from "zod";

import type { JsonSchema } from "../contract/index.ts";
import {
  pascalCase,
  pythonLiteral,
  PythonModels,
  snakeCase,
} from "./models.ts";

/** The JSON Schema a contract carries for a Zod schema. */
function jsonSchema(schema: z.ZodType, io: "input" | "output"): JsonSchema {
  // deno-lint-ignore no-explicit-any
  return (schema as any)["~standard"].jsonSchema[io]({
    target: "draft-2020-12",
    libraryOptions: { unrepresentable: "any" },
  });
}

/** The Python type of a schema and the definitions it needs. */
function python(
  schema: z.ZodType,
  options: { io?: "input" | "output"; strict?: boolean; name?: string } = {},
): { type: string; source: string } {
  const models = new PythonModels();
  const type = models.define(
    options.name ?? "Thing",
    jsonSchema(schema, options.io ?? "input"),
    options.strict ?? true,
  );
  return { type, source: models.render().join("\n").trimEnd() };
}

const CONFIG = 'populate_by_name=True, regex_engine="python-re"';

Deno.test("python models: plain types and their constraints", () => {
  const type = (schema: z.ZodType) => python(schema).type;

  assertEquals(type(z.string()), "str");
  assertEquals(
    type(z.string().min(1).max(40)),
    "Annotated[str, Field(min_length=1, max_length=40)]",
  );
  assertEquals(
    type(z.string().regex(/^[a-z]+\d$/)),
    'Annotated[str, Field(pattern="^[a-z]+\\\\d$")]',
  );
  assertEquals(type(z.boolean()), "bool");
  assertEquals(type(z.null()), "None");
  assertEquals(type(z.number()), "float");
  assertEquals(
    type(z.number().gt(0).lte(1).multipleOf(0.25)),
    "Annotated[float, Field(le=1, gt=0, multiple_of=0.25)]",
  );
  // An integer within what JavaScript represents exactly.
  assertEquals(type(z.number().int()), "SafeInt");
  assertEquals(
    type(z.number().int().min(1).max(100)),
    "Annotated[int, Field(ge=1, le=100)]",
  );
  assertEquals(type(z.literal("on")), 'Literal["on"]');
  assertEquals(type(z.enum(["a", "b"])), 'Literal["a", "b"]');
  assertEquals(type(z.string().nullable()), "str | None");
  assertEquals(type(z.union([z.string(), z.number()])), "str | float");
  // What JSON Schema cannot state accepts anything.
  assertEquals(type(z.unknown()), "Any");
  assertEquals(python(z.date(), { io: "output" }).type, "Any");
});

Deno.test("python models: lists, tuples and mappings", () => {
  const type = (schema: z.ZodType) => python(schema).type;

  assertEquals(type(z.array(z.string())), "list[str]");
  assertEquals(
    type(z.array(z.string().min(1)).min(1).max(4)),
    "Annotated[list[Annotated[str, Field(min_length=1)]], Field(min_length=1, max_length=4)]",
  );
  assertEquals(type(z.tuple([z.string(), z.number()])), "tuple[str, float]");
  assertEquals(type(z.record(z.string(), z.number())), "dict[str, float]");
});

Deno.test("python models: an object is a class; optional, default and nullable fields", () => {
  const schema = z.object({
    id: z.string(),
    nickname: z.string().optional(),
    role: z.enum(["admin", "member"]).default("member"),
    tags: z.array(z.string()).default([]),
    bio: z.string().nullable(),
    age: z.number().int().nullable().optional(),
  });

  // What a client sends: a default makes the field optional.
  assertEquals(
    python(schema, { name: "UserBody" }),
    {
      type: "UserBody",
      source: [
        "class UserBody(BaseModel):",
        `    model_config = ConfigDict(strict=True, ${CONFIG})`,
        "    id: str",
        "    nickname: str | None = None",
        '    role: Literal["admin", "member"] = "member"',
        "    tags: list[str] = []",
        "    bio: str | None",
        "    age: SafeInt | None = None",
      ].join("\n"),
    },
  );

  // What a response carries: the default was applied, the field is there,
  // and the object is closed.
  assertEquals(
    python(schema, { name: "User", io: "output" }).source.split("\n").slice(
      1,
      5,
    ),
    [
      `    model_config = ConfigDict(strict=True, extra="forbid", ${CONFIG})`,
      "    id: str",
      "    nickname: str | None = None",
      '    role: Literal["admin", "member"]',
    ],
  );

  // Query and path parameters arrive as text: not strict.
  assertEquals(
    python(z.object({ limit: z.coerce.number().int() }), {
      name: "Query",
      strict: false,
    }).source.split("\n")[1],
    `    model_config = ConfigDict(${CONFIG})`,
  );

  // A closed object on the input side.
  assertEquals(
    python(z.strictObject({ a: z.string() })).source.split("\n")[1],
    `    model_config = ConfigDict(strict=True, extra="forbid", ${CONFIG})`,
  );
});

Deno.test("python models: names Python cannot use keep their wire name as an alias", () => {
  const { source } = python(
    z.object({
      from: z.string(),
      "data-id": z.string().optional(),
      _private: z.number(),
      model_name: z.string(),
      "2fa": z.boolean(),
      fine_name: z.string(),
    }),
  );
  assertEquals(source.split("\n").slice(2), [
    '    from_: str = Field(validation_alias="from", serialization_alias="from")',
    '    data_id: str | None = Field(default=None, validation_alias="data-id", serialization_alias="data-id")',
    '    private: float = Field(validation_alias="_private", serialization_alias="_private")',
    '    model_name_: str = Field(validation_alias="model_name", serialization_alias="model_name")',
    '    field_2fa: bool = Field(validation_alias="2fa", serialization_alias="2fa")',
    "    fine_name: str",
  ]);
});

Deno.test("python models: nested objects are classes defined before their use", () => {
  const { type, source } = python(
    z.object({
      owner: z.object({ name: z.string() }),
      items: z.array(z.object({ sku: z.string() })),
    }),
    { name: "Order" },
  );
  assertEquals(type, "Order");
  assertEquals(
    source.split("\n").filter((line) => /^class |^ {4}\w+: /.test(line)),
    [
      "class OrderOwner(BaseModel):",
      "    name: str",
      "class OrderItemsItem(BaseModel):",
      "    sku: str",
      "class Order(BaseModel):",
      "    owner: OrderOwner",
      "    items: list[OrderItemsItem]",
    ],
  );
});

Deno.test("python models: a union told apart by a field is discriminated", () => {
  const { type, source } = python(
    z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("circle"), radius: z.number() }),
      z.object({ kind: z.literal("rect"), width: z.number() }),
    ]),
    { name: "Shape" },
  );
  assertEquals(
    type,
    'Annotated[ShapeCircle | ShapeRect, Field(discriminator="kind")]',
  );
  assertEquals(
    source.split("\n").filter((line) => line.startsWith("class ")),
    ["class ShapeCircle(BaseModel):", "class ShapeRect(BaseModel):"],
  );

  // No such field: a plain union, members named by position.
  assertEquals(
    python(
      z.union([z.object({ a: z.string() }), z.object({ b: z.string() })]),
      { name: "Either" },
    ).type,
    "Either1 | Either2",
  );
});

Deno.test("python models: a schema that refers to itself", () => {
  interface Tree {
    name: string;
    children: Tree[];
  }
  const Tree: z.ZodType<Tree> = z.object({
    name: z.string(),
    get children() {
      return z.array(Tree);
    },
  });

  assertEquals(python(Tree, { name: "Tree" }).source.split("\n").slice(2), [
    "    name: str",
    '    children: list["Tree"]',
    "",
    "",
    "Tree.model_rebuild()",
  ]);

  // Inside another schema, the class is named after the field that holds
  // it, not after the name Zod gives the definition.
  const { source } = python(z.object({ root: Tree }), { name: "Forest" });
  assertEquals(
    source.split("\n").filter((line) => /^class |children|rebuild/.test(line)),
    [
      "class ForestRoot(BaseModel):",
      '    children: list["ForestRoot"]',
      "class Forest(BaseModel):",
      "ForestRoot.model_rebuild()",
    ],
  );
});

Deno.test("python models: a named schema is one class; the same object twice is one class with two names", () => {
  const Tag = z.object({ label: z.string() }).meta({ id: "Tag" });
  const Note = z.object({ id: z.string(), tags: z.array(Tag) });
  const models = new PythonModels();

  const listed = models.define(
    "NotesListResponse",
    jsonSchema(z.object({ items: z.array(Note) }), "output"),
    true,
  );
  const retrieved = models.define(
    "NotesRetrieveResponse",
    jsonSchema(Note, "output"),
    true,
  );
  assertEquals([listed, retrieved], [
    "NotesListResponse",
    "NotesRetrieveResponse",
  ]);

  const source = models.render().join("\n");
  assertEquals(
    source.split("\n").filter((line) => /^class |^\w+ = /.test(line)),
    [
      "class Tag(BaseModel):",
      "class NotesListResponseItemsItem(BaseModel):",
      "class NotesListResponse(BaseModel):",
      // The note a retrieval returns is the note a list returns.
      "NotesRetrieveResponse = NotesListResponseItemsItem",
    ],
  );

  // Two different schemas under one name are refused.
  const other = z.object({ label: z.number() }).meta({ id: "Tag" });
  assertThrows(
    () =>
      models.define("X", jsonSchema(z.object({ t: other }), "output"), true),
    Error,
    'Two different schemas are named "Tag"',
  );
});

Deno.test("python models: descriptions become docstrings and field descriptions", () => {
  const { source } = python(
    z.object({ id: z.string().describe("The id") }).describe("A thing"),
  );
  assertEquals(source.split("\n").slice(1, 5), [
    '    """A thing"""',
    "",
    `    model_config = ConfigDict(strict=True, ${CONFIG})`,
    '    id: str = Field(description="The id")',
  ]);
});

Deno.test("python models: names and literals", () => {
  assertEquals(pascalCase("usersRetrieve"), "UsersRetrieve");
  assertEquals(pascalCase("data-id"), "DataId");
  assertEquals(pascalCase("2fa"), "_2fa");
  assertEquals(snakeCase("usersPostsList"), "users_posts_list");
  assertEquals(snakeCase("import"), "import_");

  assertEquals(pythonLiteral(null), "None");
  assertEquals(pythonLiteral(true), "True");
  assertEquals(pythonLiteral(1.5), "1.5");
  assertEquals(pythonLiteral('a "b"\n'), '"a \\"b\\"\\n"');
  assertEquals(
    pythonLiteral({ a: [1, false], b: null }),
    '{"a": [1, False], "b": None}',
  );
});

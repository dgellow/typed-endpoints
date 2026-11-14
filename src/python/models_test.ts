/**
 * JSON Schema to Pydantic source, case by case.
 *
 * These tests compare text. That the text is Python that runs, validates,
 * type-checks, is formatted as `ruff format` formats and passes `ruff
 * check` is established by `./scripts/test-python`.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { z } from "zod";

import type { JsonSchema } from "../contract/index.ts";
import {
  argumentName,
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

/** The classes of a module, without the base classes they share. */
function classes(source: string): string {
  const at = source.search(/^(class (?!_)|[A-Z]\w* = |type )/m);
  return at < 0 ? "" : source.slice(at);
}

const MODEL = `class _Model(BaseModel):
    """What every model of this module has in common."""

    model_config = ConfigDict(
        allow_inf_nan=False,
        populate_by_name=True,
        regex_engine="python-re",
        use_attribute_docstrings=True,
    )`;

const IS_NONE = `def _is_none(value: object) -> bool:
    """Whether a member that may be left out is left out.

    None is how Python says that it is, and such a member is not written.
    Where null is a value of a member, None is that value: the member is
    written as null when it was set to None, and not at all when it was
    not set.
    """
    return value is None`;

const JSON_MODEL = `class _Json(_Model):
    """A model of JSON: a value keeps the type it has there."""

    model_config = ConfigDict(strict=True)`;

const CLOSED_JSON_MODEL = `class _ClosedJson(_Json):
    """A model of JSON that refuses members it does not name."""

    model_config = ConfigDict(extra="forbid")`;

Deno.test("python models: plain types and their constraints", () => {
  const type = (schema: z.ZodType) => python(schema).type;

  assertEquals(type(z.string()), "str");
  assertEquals(
    type(z.string().min(1).max(40)),
    "Annotated[str, Field(min_length=1, max_length=40)]",
  );
  // A pattern stays as JavaScript writes it, in a raw string; `_pattern()`
  // compiles it as JavaScript reads it.
  assertEquals(
    type(z.string().regex(/^[a-z]+\d$/)),
    'Annotated[str, Field(pattern=_pattern(r"^[a-z]+\\d$"))]',
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
  // None is written last, wherever the schema has it.
  assertEquals(
    type(z.union([z.null(), z.string(), z.number()])),
    "str | float | None",
  );
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
  assertEquals(
    type(z.tuple([z.string(), z.number()])),
    "Annotated[tuple[str, float], Field(strict=False)]",
  );
  assertEquals(
    python(z.tuple([z.string(), z.number()]), { strict: false }).type,
    "tuple[str, float]",
  );
  assertEquals(type(z.record(z.string(), z.number())), "dict[str, float]");
});

Deno.test("python models: an object is a class; what a member has to satisfy is in its Field", () => {
  const schema = z.object({
    id: z.string(),
    nickname: z.string().min(2).optional(),
    role: z.enum(["admin", "member"]).default("member"),
    tags: z.array(z.string().min(1)).max(4).default([]),
    bio: z.string().nullable(),
    age: z.number().int().nullable().optional(),
    limit: z.number().int().min(1).max(100).default(20),
  });

  // What a client sends: a default makes the field optional. The class
  // says what it shares with the others by its base class.
  assertEquals(
    python(schema, { name: "UserBody" }),
    {
      type: "UserBody",
      source: `${IS_NONE}


${MODEL}


${JSON_MODEL}


class UserBody(_Json):
    """An object of the API."""

    id: str
    nickname: str | None = Field(default=None, min_length=2, exclude_if=_is_none)
    role: Literal["admin", "member"] = "member"
    tags: list[Annotated[str, Field(min_length=1)]] = Field(
        default_factory=list, max_length=4
    )
    bio: str | None
    age: SafeInt | None = None
    limit: int = Field(default=20, ge=1, le=100)`,
    },
  );

  // What a response carries: the default was applied, the field is there,
  // and the object is closed.
  assertEquals(
    // After `_is_none()` and the two base classes above.
    python(schema, { name: "User", io: "output" }).source.split("\n\n\n")
      .slice(3).join("\n\n\n").split("\n").slice(0, 12),
    [
      ...CLOSED_JSON_MODEL.split("\n"),
      "",
      "",
      "class User(_ClosedJson):",
      '    """An object of the API."""',
      "",
      "    id: str",
      "    nickname: str | None = Field(default=None, min_length=2, exclude_if=_is_none)",
      '    role: Literal["admin", "member"]',
    ],
  );

  // Query and path parameters arrive as text: not strict.
  assertEquals(
    classes(
      python(z.object({ limit: z.coerce.number().int() }), {
        name: "Query",
        strict: false,
      }).source,
    ).split("\n")[0],
    "class Query(_Model):",
  );
});

Deno.test("python models: None for a member that may be left out is not written, unless null is a value of it", () => {
  const lines = classes(
    python(
      z.object({
        // Left out or there: None is how Python says "left out".
        pinned: z.boolean().optional(),
        // Left out, null or there: three states, and None is null.
        note: z.string().nullable().optional(),
        // Anything, null included.
        extra: z.unknown().optional(),
        kind: z.union([z.literal("a"), z.null()]).optional(),
        // Not left out by a client that says nothing: it has a default.
        limit: z.number().default(2),
      }),
    ).source,
  ).split("\n").slice(3);
  assertEquals(lines, [
    "    pinned: bool | None = Field(default=None, exclude_if=_is_none)",
    "    note: str | None = None",
    "    extra: Any | None = None",
    '    kind: Literal["a"] | None = None',
    "    limit: float = 2",
  ]);
});

Deno.test("python models: an attribute is in snake case, with an alias for its name on the wire", () => {
  assertEquals(
    classes(
      python(
        z.object({
          from: z.string(),
          "data-id": z.string().optional(),
          _private: z.number(),
          model_name: z.string(),
          "2fa": z.boolean(),
          fine_name: z.string(),
          // Two names that are one name in snake case.
          createdAt: z.string(),
          created_at: z.string(),
        }),
      ).source,
    ),
    `class Thing(_Json):
    """An object of the API."""

    from_: str = Field(validation_alias="from", serialization_alias="from")
    data_id: str | None = Field(
        default=None,
        exclude_if=_is_none,
        validation_alias="data-id",
        serialization_alias="data-id",
    )
    private: float = Field(validation_alias="_private", serialization_alias="_private")
    model_name_: str = Field(
        validation_alias="model_name", serialization_alias="model_name"
    )
    field_2fa: bool = Field(validation_alias="2fa", serialization_alias="2fa")
    fine_name: str
    created_at: str = Field(
        validation_alias="createdAt", serialization_alias="createdAt"
    )
    created_at_2: str = Field(
        validation_alias="created_at", serialization_alias="created_at"
    )`,
  );
});

Deno.test("python models: when most names are camel case the models share an alias generator", () => {
  const { source } = python(
    z.object({
      createdAt: z.string(),
      updatedAt: z.string(),
      id: z.string(),
      // The exceptions say their alias.
      display_name: z.string(),
      userID: z.string(),
    }),
  );
  assertEquals(
    source.split("\n\n\n")[0],
    `class _Model(BaseModel):
    """What every model of this module has in common."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        allow_inf_nan=False,
        populate_by_name=True,
        regex_engine="python-re",
        use_attribute_docstrings=True,
    )`,
  );
  assertEquals(
    classes(source),
    `class Thing(_Json):
    """An object of the API."""

    created_at: str
    updated_at: str
    id: str
    display_name: str = Field(
        validation_alias="display_name", serialization_alias="display_name"
    )
    user_id: str = Field(validation_alias="userID", serialization_alias="userID")`,
  );
});

Deno.test("python models: nested objects are classes defined before their use, and say where they are from", () => {
  assertEquals(
    classes(
      python(
        z.object({
          owner: z.object({ name: z.string() }),
          items: z.array(z.object({ sku: z.string() })),
          shape: z.discriminatedUnion("kind", [
            z.object({ kind: z.literal("circle"), radius: z.number() }),
            z.object({ kind: z.literal("rect"), width: z.number() }),
          ]),
        }),
        { name: "Order" },
      ).source,
    ),
    `class OrderOwner(_Json):
    """The member \`owner\` of \`Order\`."""

    name: str


class OrderItemsItem(_Json):
    """An item of the member \`items\` of \`Order\`."""

    sku: str


class OrderShapeCircle(_Json):
    """The alternative \`circle\` of the member \`shape\` of \`Order\`."""

    kind: Literal["circle"]
    radius: float


class OrderShapeRect(_Json):
    """The alternative \`rect\` of the member \`shape\` of \`Order\`."""

    kind: Literal["rect"]
    width: float


class Order(_Json):
    """An object of the API."""

    owner: OrderOwner
    items: list[OrderItemsItem]
    shape: OrderShapeCircle | OrderShapeRect = Field(discriminator="kind")`,
  );

  // Not told apart by a field: a plain union.
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
  // The class does not exist yet inside itself: the annotation is a
  // string, and the class is completed afterwards.
  assertEquals(
    classes(python(Tree, { name: "Tree" }).source),
    `class Tree(_Json):
    """An object of the API."""

    name: str
    children: "list[Tree]"


Tree.model_rebuild()`,
  );
});

Deno.test("python models: a type that refers to itself and is not a class is a type statement", () => {
  type Json = string | null | Json[] | { [key: string]: Json };
  const Json: z.ZodType<Json> = z.union([
    z.string(),
    z.null(),
    z.array(z.lazy(() => Json)),
    z.record(z.string(), z.lazy(() => Json)),
  ]);
  const models = new PythonModels();
  models.define(
    "Thing",
    jsonSchema(z.object({ data: Json, more: Json.optional() }), "input"),
    true,
  );
  assertEquals(
    classes(models.render().join("\n").trimEnd()),
    `type ThingData = str | list[ThingData] | dict[str, ThingData] | None


class Thing(_Json):
    """An object of the API."""

    data: ThingData
    more: ThingData | None = None`,
  );
  assertEquals(models.usesTypeStatement, true);
});

Deno.test("python models: a named schema is one class; the same object twice is one class with two names", () => {
  const Tag = z.object({ label: z.string() }).meta({ id: "Tag" });
  const Note = z.object({ id: z.string(), tags: z.array(Tag) });

  const models = new PythonModels();
  const list = models.define(
    "NotesListResponse",
    jsonSchema(z.object({ items: z.array(Note) }), "output"),
    true,
  );
  const one = models.define(
    "NotesRetrieveResponse",
    jsonSchema(Note, "output"),
    true,
  );
  const again = models.define(
    "NotesUpdateResponse",
    jsonSchema(Note, "output"),
    true,
  );
  assertEquals([list, one, again], [
    "NotesListResponse",
    "NotesRetrieveResponse",
    "NotesUpdateResponse",
  ]);
  const source = models.render().join("\n");
  assertEquals(source.match(/^class (?!_)\w+/gm), [
    "class Tag",
    "class NotesListResponseItemsItem",
    "class NotesListResponse",
  ]);
  // The other names stay together, after the class they name.
  assertEquals(
    source.includes(
      "NotesRetrieveResponse = NotesListResponseItemsItem\n" +
        "NotesUpdateResponse = NotesListResponseItemsItem\n",
    ),
    true,
  );

  // Two schemas under one id cannot both be the class.
  const other = z.object({ label: z.number() }).meta({ id: "Tag" });
  assertThrows(
    () =>
      models.define("X", jsonSchema(z.object({ t: other }), "output"), true),
    Error,
    'Two different schemas are named "Tag"',
  );
});

Deno.test("python models: every class has a docstring: its description, or where it is used", () => {
  // A description, and the description of a member under the member.
  assertEquals(
    classes(
      python(
        z.object({
          id: z.string().describe("Where it is kept.\nNever reused."),
          name: z.string(),
        }).describe("A thing"),
      ).source,
    ),
    `class Thing(_Json):
    """A thing."""

    id: str
    """Where it is kept.
    Never reused.
    """

    name: str`,
  );

  // No description: the operations that use it, and as what.
  const models = new PythonModels();
  const schema = jsonSchema(z.object({ id: z.string() }), "input");
  for (
    const [name, operation] of [
      ["NotesDelete", "DELETE /api/notes/{id}"],
      ["NotesRetrieve", "GET /api/notes/{id}"],
      ["NotesUpdate", "PUT /api/notes/{id}"],
    ]
  ) {
    const type = models.define(`${name}Params`, schema, false);
    models.describe(type, "path parameters", operation);
  }
  const body = models.define(
    "NotesCreateBody",
    jsonSchema(z.object({ title: z.string() }), "input"),
    true,
  );
  models.describe(body, "body", "POST /api/notes");
  assertEquals(
    classes(models.render().join("\n").trimEnd()),
    // A list too long for the first line follows a summary.
    `class NotesDeleteParams(_Model):
    """The path parameters of 3 operations.

    \`DELETE /api/notes/{id}\`, \`GET /api/notes/{id}\` and \`PUT /api/notes/{id}\`.
    """

    id: str


NotesRetrieveParams = NotesDeleteParams
NotesUpdateParams = NotesDeleteParams


class NotesCreateBody(_Json):
    """The body of \`POST /api/notes\`."""

    title: str`,
  );
});

Deno.test("python models: a long pattern is a constant with a name", () => {
  const { source } = python(
    z.object({
      id: z.uuid(),
      code: z.string().regex(/^[a-z]+\d$/),
      plan: z.string().regex(
        /^(alpha|beta|gamma|delta|epsilon|zeta|eta|theta|iota|kappa)-[0-9]{4}$/,
      ),
      again: z.uuid().optional(),
    }),
  );
  assertEquals(
    // After `_pattern()`, which compiles them.
    source.split("\n\n\n")[1],
    `_UUID_PATTERN = (
    "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-f"
    "A-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff"
    ")$"
)
_PATTERN_1 = "^(alpha|beta|gamma|delta|epsilon|zeta|eta|theta|iota|kappa)-[0-9]{4}$"`,
  );
  assertEquals(
    classes(source).split("\n").slice(3),
    [
      // What a format means has the format's name; the same pattern is
      // the same constant.
      "    id: str = Field(pattern=_pattern(_UUID_PATTERN))",
      '    code: str = Field(pattern=_pattern(r"^[a-z]+\\d$"))',
      "    plan: str = Field(pattern=_pattern(_PATTERN_1))",
      "    again: str | None = Field(",
      "        default=None, pattern=_pattern(_UUID_PATTERN), exclude_if=_is_none",
      "    )",
    ],
  );
});

Deno.test("python models: names and literals", () => {
  assertEquals(pascalCase("usersRetrieve"), "UsersRetrieve");
  assertEquals(pascalCase("user-posts_list"), "UserPostsList");
  assertEquals(pascalCase("2fa"), "_2fa");
  assertEquals(snakeCase("usersRetrieve"), "users_retrieve");
  assertEquals(snakeCase("class"), "class_");
  // An argument does not take the name of a builtin.
  assertEquals(argumentName("id"), "id_");
  assertEquals(argumentName("noteId"), "note_id");

  assertEquals(pythonLiteral(null), "None");
  assertEquals(pythonLiteral(true), "True");
  assertEquals(pythonLiteral(1.5), "1.5");
  assertEquals(pythonLiteral("a\nb"), '"a\\nb"');
  // The quotes that need no escape.
  assertEquals(pythonLiteral('say "hi"'), "'say \"hi\"'");
  assertEquals(pythonLiteral('it\'s "so"'), '"it\'s \\"so\\""');
  assertEquals(pythonLiteral([1, "a", null]), '[1, "a", None]');
  assertEquals(pythonLiteral({ a: [true] }), '{"a": [True]}');
});

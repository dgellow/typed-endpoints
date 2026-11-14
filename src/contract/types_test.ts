/**
 * JSON Schema to a type graph, case by case: what gets a name, what is
 * recognised as the same type, where a cycle is marked.
 */

import { assertEquals, assertThrows } from "@std/assert";
import { z } from "zod";

import type { JsonSchema } from "./index.ts";
import {
  type Definition,
  pascalCase,
  TypeGraph,
  type TypeNode,
  withoutNull,
} from "./types.ts";

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

/** The type of a schema and the definitions it needs. */
function graphOf(
  schema: z.ZodType,
  options: { name?: string; text?: boolean; io?: "input" | "output" } = {},
): { type: TypeNode; definitions: Definition[] } {
  const graph = new TypeGraph();
  const type = graph.define(
    options.name ?? "Thing",
    jsonSchema(schema, options.io),
    options.text ?? false,
  );
  return { type, definitions: graph.definitions };
}

const typeOf = (schema: z.ZodType) => graphOf(schema).type;

Deno.test("type graph: scalars keep what the schema says about them", () => {
  assertEquals(typeOf(z.boolean()), { kind: "boolean" });
  assertEquals(typeOf(z.null()), { kind: "null" });
  assertEquals(typeOf(z.string()), { kind: "string" });
  assertEquals(typeOf(z.string().min(1).max(40).regex(/^\d+$/)), {
    kind: "string",
    minLength: 1,
    maxLength: 40,
    pattern: "^\\d+$",
  });
  assertEquals(typeOf(z.number().gt(0).lte(1).multipleOf(0.25)), {
    kind: "number",
    maximum: 1,
    exclusiveMinimum: 0,
    multipleOf: 0.25,
  });
  assertEquals(typeOf(z.number().int().min(1)).kind, "integer");
  // What JSON Schema cannot state is anything.
  assertEquals(typeOf(z.date()), { kind: "any" });
  assertEquals(typeOf(z.unknown()), { kind: "any" });
});

Deno.test("type graph: literals carry the name of the place they are in", () => {
  assertEquals(typeOf(z.literal("on")), {
    kind: "literal",
    name: "Thing",
    values: ["on"],
  });
  assertEquals(typeOf(z.enum(["low", "high"])), {
    kind: "literal",
    name: "Thing",
    values: ["low", "high"],
  });

  const { definitions } = graphOf(
    z.object({ level: z.enum(["low", "high"]) }),
    { name: "Alarm" },
  );
  assertEquals(definitions, [{
    kind: "object",
    name: "Alarm",
    closed: false,
    text: false,
    fields: [{
      name: "level",
      type: { kind: "literal", name: "AlarmLevel", values: ["low", "high"] },
      required: true,
    }],
  }]);
});

Deno.test("type graph: lists, tuples and maps", () => {
  assertEquals(typeOf(z.array(z.string()).min(1).max(3)), {
    kind: "array",
    items: { kind: "string" },
    minItems: 1,
    maxItems: 3,
  });
  assertEquals(typeOf(z.tuple([z.string(), z.boolean()])), {
    kind: "tuple",
    items: [{ kind: "string" }, { kind: "boolean" }],
  });
  assertEquals(typeOf(z.record(z.string(), z.boolean())), {
    kind: "map",
    values: { kind: "boolean" },
  });
});

Deno.test("type graph: an object is a definition; the node refers to it", () => {
  const { type, definitions } = graphOf(
    z.object({
      id: z.string(),
      nickname: z.string().optional(),
      "data-id": z.string().nullable(),
      role: z.string().default("member").describe("What they may do"),
    }).describe("A person"),
    { name: "Person" },
  );
  assertEquals(type, { kind: "ref", name: "Person", cyclic: false });
  assertEquals(definitions, [{
    kind: "object",
    name: "Person",
    description: "A person",
    closed: false,
    text: false,
    fields: [
      { name: "id", type: { kind: "string" }, required: true },
      { name: "nickname", type: { kind: "string" }, required: false },
      {
        name: "data-id",
        type: {
          kind: "union",
          name: "PersonDataId",
          variants: [{ kind: "string" }, { kind: "null" }],
        },
        required: true,
      },
      {
        name: "role",
        type: { kind: "string" },
        required: false,
        default: { value: "member" },
        description: "What they may do",
      },
    ],
  }]);
});

Deno.test("type graph: a strict object is closed; the output side of a default is required", () => {
  const strict = graphOf(z.strictObject({ id: z.string() }));
  assertEquals(
    strict.definitions.map((d) => d.kind === "object" && d.closed),
    [true],
  );

  // Once parsed, a field with a default is always there.
  const output = graphOf(z.object({ role: z.string().default("member") }), {
    io: "output",
  });
  const [definition] = output.definitions;
  assertEquals(
    definition.kind === "object" && definition.fields[0].required,
    true,
  );
});

Deno.test("type graph: nested objects are named by their place and defined first", () => {
  const { definitions } = graphOf(
    z.object({
      owner: z.object({ name: z.string() }),
      tags: z.array(z.object({ label: z.string() })),
    }),
    { name: "Repo" },
  );
  assertEquals(definitions.map((d) => d.name), [
    "RepoOwner",
    "RepoTagsItem",
    "Repo",
  ]);
});

Deno.test("type graph: the same object in a second place is another name for the first", () => {
  const Money = z.object({ amount: z.number(), currency: z.string() });
  const graph = new TypeGraph();
  const first = graph.define("Price", jsonSchema(Money), false);
  const second = graph.define("Refund", jsonSchema(Money), false);
  // Same fields, but values that arrive as text are read differently.
  const third = graph.define("Filter", jsonSchema(Money), true);

  assertEquals(first, { kind: "ref", name: "Price", cyclic: false });
  assertEquals(second, { kind: "ref", name: "Refund", cyclic: false });
  assertEquals(third, { kind: "ref", name: "Filter", cyclic: false });
  assertEquals(
    graph.definitions.map((d) =>
      d.kind === "alias" ? `${d.name} = ${d.target}` : d.name
    ),
    ["Price", "Refund = Price", "Filter"],
  );
  // A generator that asks for the object gets it under either name.
  assertEquals(graph.object("Refund"), graph.object("Price"));
  assertEquals(graph.object("Filter")?.text, true);
  assertEquals(graph.object("Nothing"), undefined);
});

Deno.test("type graph: a name that is taken gets a number", () => {
  const graph = new TypeGraph();
  graph.define("Thing", jsonSchema(z.object({ a: z.string() })), false);
  const other = graph.define(
    "Thing",
    jsonSchema(z.object({ b: z.string() })),
    false,
  );
  assertEquals(other, { kind: "ref", name: "Thing2", cyclic: false });
});

Deno.test("type graph: a schema with an id is one definition, wherever it is used", () => {
  const Author = z.object({ name: z.string() }).meta({ id: "Author" });
  const graph = new TypeGraph();
  graph.define("Post", jsonSchema(z.object({ author: Author })), false);
  graph.define(
    "Comment",
    jsonSchema(z.object({ by: Author, text: z.string() })),
    false,
  );
  assertEquals(graph.definitions.map((d) => d.name), [
    "Author",
    "Post",
    "Comment",
  ]);

  // Two schemas under one id cannot both have the name.
  const Other = z.object({ handle: z.string() }).meta({ id: "Author" });
  assertThrows(
    () => graph.define("Reply", jsonSchema(z.object({ by: Other })), false),
    Error,
    'Two different schemas are named "Author"',
  );
});

Deno.test("type graph: a union names its variants; a field that tells them apart is found", () => {
  const Shape = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("circle"), radius: z.number() }),
    z.object({ kind: z.literal("square"), side: z.number() }),
  ]);
  const { type, definitions } = graphOf(Shape, { name: "Shape" });
  assertEquals(type, {
    kind: "union",
    name: "Shape",
    discriminator: "kind",
    variants: [
      { kind: "ref", name: "ShapeCircle", cyclic: false },
      { kind: "ref", name: "ShapeSquare", cyclic: false },
    ],
  });
  assertEquals(definitions.map((d) => d.name), ["ShapeCircle", "ShapeSquare"]);

  // Without such a field the variants are numbered.
  const plain = graphOf(
    z.union([z.object({ a: z.string() }), z.object({ b: z.string() })]),
    { name: "Either" },
  );
  assertEquals(plain.type.kind, "union");
  assertEquals("discriminator" in plain.type, false);
  assertEquals(plain.definitions.map((d) => d.name), ["Either1", "Either2"]);

  // The same constant twice tells nothing apart.
  const same = graphOf(
    z.union([
      z.object({ kind: z.literal("a"), x: z.string() }),
      z.object({ kind: z.literal("a"), y: z.string() }),
    ]),
  );
  assertEquals(same.type.kind, "union");
  assertEquals("discriminator" in same.type, false);
});

Deno.test("type graph: a schema that refers to itself is marked where the cycle closes", () => {
  const Tree: z.ZodType = z.object({
    label: z.string(),
    get children() {
      return z.array(Tree);
    },
    get parent() {
      return Tree.optional();
    },
  });
  const { type, definitions } = graphOf(Tree, { name: "Tree" });
  assertEquals(type, { kind: "ref", name: "Tree", cyclic: false });
  assertEquals(definitions.length, 1);
  const [tree] = definitions;
  assertEquals(tree.kind === "object" && tree.fields.slice(1), [
    {
      name: "children",
      type: {
        kind: "array",
        items: { kind: "ref", name: "Tree", cyclic: true },
      },
      required: true,
    },
    {
      name: "parent",
      type: { kind: "ref", name: "Tree", cyclic: true },
      required: false,
    },
  ]);
});

Deno.test("type graph: a type that refers to itself and is not an object is a definition", () => {
  type Json = string | null | Json[] | { [key: string]: Json };
  const Json: z.ZodType<Json> = z.union([
    z.string(),
    z.null(),
    z.array(z.lazy(() => Json)),
    z.record(z.string(), z.lazy(() => Json)),
  ]);
  const self: TypeNode = { kind: "ref", name: "Json", cyclic: true };
  const json: Definition = {
    kind: "named",
    name: "Json",
    type: {
      kind: "union",
      name: "Json",
      variants: [
        { kind: "string" },
        { kind: "null" },
        { kind: "array", items: self },
        { kind: "map", values: self },
      ],
    },
  };

  // As the root of a document.
  const root = graphOf(Json, { name: "Json" });
  assertEquals(root.type, { kind: "ref", name: "Json", cyclic: false });
  assertEquals(root.definitions, [json]);

  // In two fields of an object: one definition, named after the first.
  const graph = new TypeGraph();
  const schema = z.object({ data: Json, more: Json.optional() });
  graph.define("Doc", jsonSchema(schema), false);
  const data: TypeNode = { kind: "ref", name: "DocData", cyclic: false };
  assertEquals(graph.definitions.map((d) => d.name), ["DocData", "Doc"]);
  assertEquals(graph.object("Doc")?.fields.map((field) => field.type), [
    data,
    data,
  ]);
  // The other side of the same schema is the same type.
  graph.define("DocResponse", jsonSchema(schema, "output"), false);
  assertEquals(graph.object("DocResponse")?.fields[0].type, data);

  // Null is one of its values, which a reference does not show.
  assertEquals(graph.nullable(data), true);
  assertEquals(graph.nullable({ kind: "string" }), false);
  assertEquals(
    graph.nullable({ kind: "ref", name: "Doc", cyclic: false }),
    false,
  );
  // It is not an object.
  assertEquals(graph.object("DocData"), undefined);
});

Deno.test("type graph: a union that refers to itself through an object", () => {
  type Expr = number | { op: "neg"; of: Expr };
  const Expr: z.ZodType<Expr> = z.union([
    z.number(),
    z.object({
      op: z.literal("neg"),
      get of() {
        return Expr;
      },
    }),
  ]);
  const { type, definitions } = graphOf(z.object({ expr: Expr }), {
    name: "Sum",
  });
  assertEquals(type, { kind: "ref", name: "Sum", cyclic: false });
  assertEquals(definitions.map((d) => `${d.kind} ${d.name}`), [
    "object SumExpr2",
    "named SumExpr",
    "object Sum",
  ]);
  // The object is inside the union it refers to: the cycle closes there.
  const [inner] = definitions;
  assertEquals(inner.kind === "object" && inner.fields[1], {
    name: "of",
    type: { kind: "ref", name: "SumExpr", cyclic: true },
    required: true,
  });
});

Deno.test("type graph: an intersection of objects is one object", () => {
  const { definitions } = graphOf(
    z.intersection(
      z.object({ id: z.string() }),
      z.object({ name: z.string().optional() }),
    ),
    { name: "Both" },
  );
  assertEquals(definitions, [{
    kind: "object",
    name: "Both",
    closed: false,
    text: false,
    fields: [
      { name: "id", type: { kind: "string" }, required: true },
      { name: "name", type: { kind: "string" }, required: false },
    ],
  }]);
  // Of anything else, it is not stated.
  assertEquals(typeOf(z.intersection(z.string(), z.number())), { kind: "any" });
});

Deno.test("type graph: withoutNull() splits a nullable type", () => {
  const nullable = typeOf(z.string().nullable());
  assertEquals(withoutNull(nullable), {
    type: { kind: "string" },
    nullable: true,
  });
  assertEquals(withoutNull({ kind: "string" }), {
    type: { kind: "string" },
    nullable: false,
  });
  assertEquals(withoutNull({ kind: "null" }), {
    type: { kind: "null" },
    nullable: true,
  });
  // More than one type besides null stays a union.
  const three = typeOf(z.union([z.string(), z.number(), z.null()]));
  assertEquals(withoutNull(three), {
    type: {
      kind: "union",
      name: "Thing",
      variants: [{ kind: "string" }, { kind: "number" }],
    },
    nullable: true,
  });
});

Deno.test("type graph: pascalCase()", () => {
  assertEquals(pascalCase("usersRetrieve"), "UsersRetrieve");
  assertEquals(pascalCase("user-posts_list"), "UserPostsList");
  assertEquals(pascalCase("2fa"), "_2fa");
  assertEquals(pascalCase("--"), "_");
});

import { assertEquals, assertThrows } from "@std/assert";
import { z } from "zod";
import { TypeDeclarations, zodToTypeString } from "./zod.ts";

Deno.test("zodToTypeString converts string schema", () => {
  const schema = z.string();
  assertEquals(zodToTypeString(schema), "string");
});

Deno.test("zodToTypeString converts number schema", () => {
  const schema = z.number();
  assertEquals(zodToTypeString(schema), "number");
});

Deno.test("zodToTypeString converts boolean schema", () => {
  const schema = z.boolean();
  assertEquals(zodToTypeString(schema), "boolean");
});

Deno.test("zodToTypeString converts object schema", () => {
  const schema = z.object({
    name: z.string(),
    age: z.number(),
  });
  const result = zodToTypeString(schema);
  // Normalize whitespace for comparison
  const normalized = result.replace(/\s+/g, " ").trim();
  assertEquals(normalized, "{ name: string; age: number; }");
});

Deno.test("zodToTypeString converts array schema", () => {
  const schema = z.array(z.string());
  assertEquals(zodToTypeString(schema), "string[]");
});

Deno.test("zodToTypeString converts optional schema", () => {
  const schema = z.object({
    name: z.string(),
    nickname: z.string().optional(),
  });
  const result = zodToTypeString(schema);
  const normalized = result.replace(/\s+/g, " ").trim();
  assertEquals(normalized, "{ name: string; nickname?: string | undefined; }");
});

Deno.test("zodToTypeString converts enum schema", () => {
  const schema = z.enum(["active", "inactive"]);
  assertEquals(zodToTypeString(schema), '"active" | "inactive"');
});

Deno.test("zodToTypeString converts nullable schema", () => {
  const schema = z.string().nullable();
  assertEquals(zodToTypeString(schema), "string | null");
});

// =============================================================================
// Output that is valid TypeScript
// =============================================================================

Deno.test("zodToTypeString escapes string literals", () => {
  assertEquals(zodToTypeString(z.literal('say "hi"')), '"say \\"hi\\""');
  assertEquals(zodToTypeString(z.enum(["a\\b", "c"])), '"a\\\\b" | "c"');
});

Deno.test("zodToTypeString writes non-string literals", () => {
  assertEquals(zodToTypeString(z.literal(10n)), "10n");
  assertEquals(zodToTypeString(z.literal(null)), "null");
  assertEquals(zodToTypeString(z.literal([1, true, "x"])), '1 | true | "x"');
});

Deno.test("zodToTypeString quotes keys that are not identifiers", () => {
  assertEquals(
    zodToTypeString(z.object({ "content-type": z.string(), ok: z.number() })),
    '{ "content-type": string; ok: number; }',
  );
});

Deno.test("zodToTypeString parenthesises by precedence", () => {
  const a = z.object({ a: z.string() });
  const b = z.object({ b: z.string() });
  assertEquals(
    zodToTypeString(z.array(z.intersection(a, b))),
    "({ a: string; } & { b: string; })[]",
  );
  assertEquals(
    zodToTypeString(z.intersection(z.union([z.string(), z.number()]), b)),
    "(string | number) & { b: string; }",
  );
  assertEquals(
    zodToTypeString(z.array(z.string().nullable())),
    "(string | null)[]",
  );
  assertEquals(
    zodToTypeString(z.array(z.array(z.string()).readonly())),
    "(readonly string[])[]",
  );
});

Deno.test("zodToTypeString keeps index signatures", () => {
  assertEquals(
    zodToTypeString(z.looseObject({ a: z.string() })),
    "{ a: string; [key: string]: unknown; }",
  );
  assertEquals(
    zodToTypeString(z.object({ a: z.string() }).catchall(z.number())),
    "{ a: string; } & { [key: string]: number; }",
  );
  assertEquals(
    zodToTypeString(z.strictObject({ a: z.string() })),
    "{ a: string; }",
  );
});

Deno.test("zodToTypeString keeps readonly", () => {
  assertEquals(
    zodToTypeString(z.array(z.string()).readonly()),
    "readonly string[]",
  );
  assertEquals(
    zodToTypeString(z.object({ a: z.string() }).readonly()),
    "Readonly<{ a: string; }>",
  );
  assertEquals(
    zodToTypeString(z.map(z.string(), z.number()).readonly()),
    "ReadonlyMap<string, number>",
  );
});

Deno.test("zodToTypeString distinguishes record and partialRecord", () => {
  const keys = z.enum(["a", "b"]);
  assertEquals(
    zodToTypeString(z.record(keys, z.number())),
    'Record<"a" | "b", number>',
  );
  assertEquals(
    zodToTypeString(z.partialRecord(keys, z.number())),
    'Partial<Record<"a" | "b", number>>',
  );
});

Deno.test("zodToTypeString writes template literals", () => {
  assertEquals(
    zodToTypeString(z.templateLiteral(["user_", z.number(), "`"])),
    "`user_${number}\\``",
  );
});

Deno.test("zodToTypeString marks trailing optional tuple members", () => {
  assertEquals(
    zodToTypeString(z.tuple([z.string(), z.number().optional()])),
    "[string, (number | undefined)?]",
  );
  assertEquals(
    zodToTypeString(z.tuple([z.string()], z.boolean())),
    "[string, ...boolean[]]",
  );
});

Deno.test("zodToTypeString writes descriptions as JSDoc", () => {
  assertEquals(
    zodToTypeString(z.object({ id: z.string().describe("The user id") })),
    "{ /** The user id */ id: string; }",
  );
});

// =============================================================================
// Input and output sides
// =============================================================================

Deno.test("zodToTypeString: a default is optional on input only", () => {
  const schema = z.object({ limit: z.number().default(20) });
  assertEquals(zodToTypeString(schema), "{ limit: number; }");
  assertEquals(
    zodToTypeString(schema, { io: "input" }),
    "{ limit?: number | undefined; }",
  );
});

Deno.test("zodToTypeString: a pipe is described by the requested side", () => {
  const schema = z.string().transform((s) => s.length).pipe(z.number());
  assertEquals(zodToTypeString(schema, { io: "input" }), "string");
  assertEquals(zodToTypeString(schema, { io: "output" }), "number");
  assertEquals(zodToTypeString(z.string().transform(Number)), "unknown");
});

Deno.test("zodToTypeString: a coerced schema is its target type on input", () => {
  assertEquals(zodToTypeString(z.coerce.number(), { io: "input" }), "number");
});

Deno.test("zodToTypeString: JSON wire form", () => {
  const schema = z.object({ createdAt: z.date() });
  assertEquals(zodToTypeString(schema), "{ createdAt: Date; }");
  assertEquals(
    zodToTypeString(schema, { wire: "json" }),
    "{ createdAt: string; }",
  );
  assertEquals(
    zodToTypeString(schema, { wire: "json", io: "input" }),
    "{ createdAt: Date; }",
  );
});

Deno.test("zodToTypeString: JSON wire form rejects what JSON cannot carry", () => {
  const schema = z.object({ stats: z.object({ total: z.bigint() }) });
  assertThrows(
    () => zodToTypeString(schema, { wire: "json" }),
    Error,
    "Cannot describe z.bigint() at stats.total as JSON",
  );
  assertThrows(
    () => zodToTypeString(z.map(z.string(), z.number()), { wire: "json" }),
    Error,
    "Cannot describe z.map() at (root) as JSON",
  );
});

// =============================================================================
// Recursive schemas
// =============================================================================

type Tree = { value: string; children: Tree[] };
const Tree: z.ZodType<Tree> = z.lazy(() =>
  z.object({ value: z.string(), children: z.array(Tree) })
);

const Category = z.object({
  name: z.string(),
  get parent() {
    return Category.optional();
  },
}).meta({ id: "Category" });

Deno.test("zodToTypeString names recursive schemas", () => {
  const declarations = new TypeDeclarations();

  assertEquals(zodToTypeString(Tree, { declarations }), "Recursive");
  assertEquals(
    zodToTypeString(z.array(Category), { declarations }),
    "Category[]",
  );
  // Converting the same schema again reuses the declaration.
  assertEquals(zodToTypeString(Tree, { declarations }), "Recursive");

  assertEquals(declarations.entries(), [
    ["Recursive", "{ value: string; children: Recursive[]; }"],
    ["Category", "{ name: string; parent?: Category | undefined; }"],
  ]);
});

Deno.test("zodToTypeString names input and output sides separately", () => {
  const declarations = new TypeDeclarations();
  assertEquals(zodToTypeString(Category, { declarations }), "Category");
  assertEquals(
    zodToTypeString(Category, { declarations, io: "input" }),
    "CategoryInput",
  );
});

Deno.test("zodToTypeString rejects a recursive schema without declarations", () => {
  assertThrows(
    () => zodToTypeString(Tree),
    Error,
    "The schema is recursive (Recursive)",
  );
});

// =============================================================================
// Generated text is equivalent to z.infer
// =============================================================================

/** Schema source text. Each is evaluated and also pasted into a checked file. */
const EQUIVALENCE_CASES = [
  `z.string()`,
  `z.number().int()`,
  `z.literal("a")`,
  `z.literal(['say "hi"', 2, true, null])`,
  `z.enum(["x", "y"])`,
  `z.object({ a: z.string(), b: z.number().optional(), "c-d": z.boolean() })`,
  `z.object({ a: z.string() }).catchall(z.string())`,
  `z.looseObject({ a: z.string() })`,
  `z.array(z.union([z.string(), z.number()]))`,
  `z.array(z.intersection(z.object({ a: z.string() }), z.object({ b: z.number() })))`,
  `z.intersection(z.union([z.object({ a: z.string() }), z.object({ c: z.string() })]), z.object({ b: z.number() }))`,
  `z.tuple([z.string(), z.number()])`,
  `z.tuple([z.string(), z.number().optional()])`,
  `z.tuple([z.string()], z.boolean())`,
  `z.record(z.string(), z.number())`,
  `z.record(z.enum(["a", "b"]), z.number())`,
  `z.partialRecord(z.enum(["a", "b"]), z.number())`,
  `z.map(z.string(), z.array(z.number()))`,
  `z.set(z.string())`,
  `z.string().nullable()`,
  `z.string().nullish()`,
  `z.array(z.string()).readonly()`,
  `z.object({ a: z.array(z.string()) }).readonly()`,
  `z.object({ limit: z.number().default(20), tag: z.string().optional() })`,
  `z.discriminatedUnion("type", [z.object({ type: z.literal("ok"), v: z.number() }), z.object({ type: z.literal("err"), e: z.string() })])`,
  `z.templateLiteral(["user_", z.number()])`,
  `z.string().optional().nonoptional()`,
  `z.object({ d: z.date(), n: z.bigint(), u: z.unknown(), x: z.null() })`,
  `z.stringbool()`,
];

Deno.test("zodToTypeString output is equivalent to z.infer", async () => {
  const lines = [
    `import { z } from "zod";`,
    `type Same<A, B> = [A] extends [B] ? [B] extends [A] ? true : false : false;`,
  ];
  EQUIVALENCE_CASES.forEach((source, i) => {
    const schema = new Function("z", `return ${source};`)(z);
    lines.push(
      `const s${i} = ${source};`,
      `const _o${i}: Same<z.output<typeof s${i}>, ${
        zodToTypeString(schema)
      }> = true;`,
    );
    // Coerced schemas are deliberately not z.input; none are in the list.
    lines.push(
      `const _i${i}: Same<z.input<typeof s${i}>, ${
        zodToTypeString(schema, { io: "input" })
      }> = true;`,
    );
  });

  const dir = new URL(".", import.meta.url).pathname;
  const tmpFile = await Deno.makeTempFile({ dir, suffix: "_generated.ts" });
  try {
    await Deno.writeTextFile(tmpFile, lines.join("\n") + "\n");
    const { code, stdout, stderr } = await new Deno.Command("deno", {
      args: ["check", tmpFile],
      env: { NO_COLOR: "1" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const output = new TextDecoder().decode(stdout) +
      new TextDecoder().decode(stderr);
    assertEquals(code, 0, `Generated types differ from z.infer:\n${output}`);
  } finally {
    await Deno.remove(tmpFile);
  }
});

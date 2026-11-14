/**
 * A contract as Rust data.
 *
 * Each JSON Schema becomes a `static` of the runtime's `Schema` type: a
 * struct literal that sets the keywords the schema has. The compiler
 * checks it, nothing is parsed when the server starts, and the members of
 * an object keep the order the contract has them in, which is the order
 * issues are reported in.
 *
 * A definition (`$defs`) is a static of its own, and a reference is the
 * address of a static, also when a schema refers to itself.
 *
 * @module
 */

import type { JsonSchema } from "../contract/index.ts";
import { discriminatorOf } from "../contract/types.ts";

type Json = Readonly<Record<string, unknown>>;

/** The widest line written; the module is not formatted by rustfmt. */
const WIDTH = 100;

/** A string as a Rust string literal: plain if it can be, else raw. */
export function rustString(text: string): string {
  const control = [...text].some((c) => c.codePointAt(0)! < 0x20);
  if (control) {
    // A raw string has no escapes: control characters are written as
    // escapes in a plain one.
    const escaped = [...text].map((c) => {
      if (c === "\\" || c === '"') return `\\${c}`;
      if (c === "\n") return "\\n";
      if (c === "\r") return "\\r";
      if (c === "\t") return "\\t";
      const code = c.codePointAt(0)!;
      return code < 0x20 ? `\\u{${code.toString(16)}}` : c;
    }).join("");
    return `"${escaped}"`;
  }
  if (!/[\\"]/.test(text)) return `"${text}"`;
  // As few `#` as it takes for the text not to end the literal.
  let hashes = text.includes('"') ? 1 : 0;
  for (const match of text.matchAll(/"(#+)/g)) {
    hashes = Math.max(hashes, match[1].length + 1);
  }
  const fence = "#".repeat(hashes);
  return `r${fence}"${text}"${fence}`;
}

/** Digits in groups of three, as Rust literals are written. */
function grouped(digits: string): string {
  return digits.length < 5 ? digits : digits.replace(/\B(?=(\d{3})+$)/g, "_");
}

/** A whole number as a Rust integer literal. */
export function rustInteger(value: number): string {
  const digits = BigInt(Math.abs(value)).toString();
  return `${value < 0 ? "-" : ""}${grouped(digits)}`;
}

/** A number as a Rust `f64` literal. */
export function rustFloat(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e21) {
    return `${rustInteger(value)}.0`;
  }
  const text = String(value).replace("e+", "e");
  return /[.e]/.test(text) ? text : `${text}.0`;
}

const TYPES: Readonly<Record<string, string>> = {
  null: "Type::Null",
  boolean: "Type::Boolean",
  integer: "Type::Integer",
  number: "Type::Number",
  string: "Type::String",
  array: "Type::Array",
  object: "Type::Object",
};

/** Renders the operations and schemas of a module as statics. */
export class RustContract {
  private readonly statics: string[][] = [];
  private readonly operations: string[][] = [];
  /** Documents already written, by content: their static. */
  private readonly written = new Map<string, string>();
  private readonly names = new Set<string>();
  /** The runtime names the statics use, for the module's imports. */
  private readonly used = new Set<string>(["Schema"]);

  /**
   * The name of the static that holds a schema. The same schema under a
   * second name is the first static again.
   *
   * @param name Name for the static, in constant case.
   */
  define(name: string, schema: JsonSchema): string {
    const content = JSON.stringify(schema);
    const existing = this.written.get(content);
    if (existing !== undefined) return existing;

    const { $defs, $schema: _dialect, ...root } = schema as Json & {
      $defs?: Record<string, Json>;
    };
    const unique = this.unique(name);
    this.written.set(content, unique);

    // Each definition is a static named after the document it is in.
    const definitions = new Map<string, string>();
    for (const key of Object.keys($defs ?? {})) {
      const suffix = key.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
        .toUpperCase();
      definitions.set(key, this.unique(`${unique}_${suffix || "DEF"}`));
    }
    const target = (reference: string): string => {
      if (reference === "#") return unique;
      const key = reference.replace(/^#\/\$defs\//, "");
      const found = definitions.get(key);
      if (!found) throw new Error(`Unresolved reference ${reference}`);
      return found;
    };

    // The member that decides the alternative of a union, as the type
    // graph finds it: the checker and the types agree on it.
    const document = { root, defs: $defs ?? {} };
    const tag = (alternatives: readonly Json[]) =>
      discriminatorOf(alternatives, document);

    this.write(unique, root, target, tag);
    for (const [key, definition] of definitions) {
      this.write(definition, $defs![key], target, tag);
    }
    return unique;
  }

  /**
   * The static that describes an operation: its name for the log and the
   * schemas of its parts.
   *
   * @param name Name for the static, in constant case.
   * @param errors The static of each declared error body, by status.
   */
  operation(
    name: string,
    parts: {
      readonly label: string;
      readonly params?: string;
      readonly query?: string;
      readonly body?: string;
      readonly response?: string;
      readonly errors: ReadonlyMap<string, string>;
    },
  ): string {
    const unique = this.unique(name);
    const part = (schema: string | undefined) =>
      schema ? `Some(&${schema})` : "None";
    this.used.add("Operation");
    this.operations.push([
      `    pub(super) static ${unique}: Operation = Operation {`,
      `        name: ${rustString(parts.label)},`,
      `        params: ${part(parts.params)},`,
      `        query: ${part(parts.query)},`,
      `        body: ${part(parts.body)},`,
      `        response: ${part(parts.response)},`,
      `        errors: &[${
        [...parts.errors].map(([status, schema]) => `(${status}, &${schema})`)
          .join(", ")
      }],`,
      "    };",
    ]);
    return unique;
  }

  /** The source of the `contract` module. */
  render(): string[] {
    const imports = [...this.used].sort();
    return [
      "/// The contract as data: the operations, and the schemas the runtime",
      "/// checks their requests and responses against.",
      "#[rustfmt::skip]",
      "mod contract {",
      `    use super::runtime::${
        imports.length === 1 ? imports[0] : `{${imports.join(", ")}}`
      };`,
      ...this.operations.flatMap((lines) => ["", ...lines]),
      ...this.statics.flatMap((lines) => ["", ...lines]),
      "}",
    ];
  }

  // ---------------------------------------------------------------------------

  private unique(name: string): string {
    let candidate = name;
    for (let i = 2; this.names.has(candidate); i++) candidate = `${name}_${i}`;
    this.names.add(candidate);
    return candidate;
  }

  private write(
    name: string,
    schema: Json,
    target: (reference: string) => string,
    tag: (alternatives: readonly Json[]) => string | undefined,
  ): void {
    const head = `pub(super) static ${name}: Schema = `;
    const body = this.literal(schema, target, tag, 4, head.length);
    this.statics.push(`    ${head}${body};`.split("\n"));
  }

  /**
   * A schema as a `Schema` literal.
   *
   * @param indent Columns the literal's own line starts at.
   * @param lead Columns before the literal on its first line.
   */
  private literal(
    schema: unknown,
    target: (reference: string) => string,
    tag: (alternatives: readonly Json[]) => string | undefined,
    indent: number,
    lead = 0,
  ): string {
    if (typeof schema !== "object" || schema === null) return "Schema::ANY";
    const rules = schema as Json;
    const inner = indent + 4;
    const nested = (value: unknown, at = inner) =>
      this.literal(value, target, tag, at);
    const list = (values: readonly unknown[], at = inner) =>
      values.length === 0 ? "&[]" : [
        "&[",
        ...values.map((value) =>
          `${" ".repeat(at + 4)}${nested(value, at + 4)},`
        ),
        `${" ".repeat(at)}]`,
      ].join("\n");
    // Where the address of a schema is taken, a reference is the static.
    const address = (value: unknown) => {
      const keys = Object.keys(value as Json);
      const reference = (value as Json).$ref;
      return keys.length === 1 && typeof reference === "string"
        ? target(reference)
        : nested(value);
    };
    const count = (key: string) =>
      typeof rules[key] === "number"
        ? [`Some(${rustInteger(rules[key] as number)})`]
        : [];
    const amount = (key: string) =>
      typeof rules[key] === "number"
        ? [`Some(${rustFloat(rules[key] as number)})`]
        : [];

    const fields: [string, string][] = [];
    const set = (name: string, values: string[]) => {
      if (values.length > 0) fields.push([name, values[0]]);
    };

    if (typeof rules.$ref === "string") {
      set("reference", [`Some(&${target(rules.$ref)})`]);
    }
    const types = Array.isArray(rules.type)
      ? rules.type as string[]
      : typeof rules.type === "string"
      ? [rules.type]
      : [];
    if (types.length > 0) {
      this.used.add("Type");
      set("types", [`&[${types.map((type) => TYPES[type]).join(", ")}]`]);
    }
    if ("const" in rules) {
      set(
        "constant",
        [this.scalar(rules.const)].flatMap((literal) =>
          literal ? [`Some(${literal})`] : []
        ),
      );
    }
    if (Array.isArray(rules.enum)) {
      const options = rules.enum.map((option) => this.scalar(option));
      if (options.every((option) => option !== undefined)) {
        set("options", [`Some(&[${options.join(", ")}])`]);
      }
    }
    const alternatives = rules.anyOf ?? rules.oneOf;
    if (Array.isArray(alternatives)) {
      set("any_of", [`Some(${list(alternatives)})`]);
      const decides = tag(alternatives as Json[]);
      if (decides !== undefined) set("tag", [`Some(${rustString(decides)})`]);
    }
    if (Array.isArray(rules.allOf)) {
      set("all_of", [`Some(${list(rules.allOf)})`]);
    }
    set("min_length", count("minLength"));
    set("max_length", count("maxLength"));
    if (typeof rules.pattern === "string") {
      set("pattern", [`Some(${rustString(rules.pattern)})`]);
    }
    if (typeof rules.format === "string") {
      set("format", [`Some(${rustString(rules.format)})`]);
    }
    set("minimum", amount("minimum"));
    set("maximum", amount("maximum"));
    set("exclusive_minimum", amount("exclusiveMinimum"));
    set("exclusive_maximum", amount("exclusiveMaximum"));
    set("multiple_of", amount("multipleOf"));
    set("min_items", count("minItems"));
    set("max_items", count("maxItems"));
    if (typeof rules.items === "object" && rules.items !== null) {
      set("items", [`Some(&${address(rules.items)})`]);
    }
    if (Array.isArray(rules.prefixItems)) {
      set("prefix_items", [`Some(${list(rules.prefixItems)})`]);
    }
    if (typeof rules.properties === "object" && rules.properties !== null) {
      const members = Object.entries(rules.properties as Json).map((
        [name, member],
      ) =>
        `${" ".repeat(inner + 4)}(${rustString(name)}, ${
          nested(member, inner + 4)
        }),`
      );
      set("properties", [
        members.length === 0
          ? "Some(&[])"
          : ["Some(&[", ...members, `${" ".repeat(inner)}])`].join("\n"),
      ]);
    }
    if (Array.isArray(rules.required) && rules.required.length > 0) {
      set("required", [
        `&[${(rules.required as string[]).map(rustString).join(", ")}]`,
      ]);
    }
    const additional = rules.additionalProperties;
    if (additional === false) {
      this.used.add("Additional");
      set("additional", ["Additional::Refused"]);
    } else if (typeof additional === "object" && additional !== null) {
      this.used.add("Additional");
      set("additional", [`Additional::Each(&${address(additional)})`]);
    }

    if (fields.length === 0) return "Schema::ANY";
    const pairs = fields.map(([name, value]) => `${name}: ${value}`);
    const line = `Schema { ${pairs.join(", ")}, ..Schema::ANY }`;
    if (!line.includes("\n") && indent + lead + line.length + 2 <= WIDTH) {
      return line;
    }
    return [
      "Schema {",
      ...pairs.map((pair) => `${" ".repeat(inner)}${pair},`),
      `${" ".repeat(inner)}..Schema::ANY`,
      `${" ".repeat(indent)}}`,
    ].join("\n");
  }

  /** A constant or an option as a `Literal`, if it is a scalar. */
  private scalar(value: unknown): string | undefined {
    this.used.add("Literal");
    if (value === null) return "Literal::Null";
    if (typeof value === "boolean") return `Literal::Bool(${value})`;
    if (typeof value === "number") {
      return `Literal::Number(${rustFloat(value)})`;
    }
    if (typeof value === "string") return `Literal::Text(${rustString(value)})`;
    return undefined;
  }
}

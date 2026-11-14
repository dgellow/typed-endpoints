/**
 * Rust types from the types of a contract.
 *
 * Every object becomes a struct, every set of string literals an enum,
 * every union an untagged enum. A union that refers to itself (a JSON
 * value, an expression) is an enum under its own name, with a `Null`
 * variant if null is one of its values. The types say what Rust's type system can
 * say: which fields there are, which may be absent, which may be null,
 * which strings are allowed. What it cannot say (lengths, bounds,
 * patterns) is checked by the runtime against the contract's schema
 * before a value of the type is built, and before one is sent.
 *
 * Absent and null are different on the wire and in the types:
 *
 * | The field            | In Rust             | Written as                |
 * | -------------------- | ------------------- | ------------------------- |
 * | required             | `T`                 | the value                 |
 * | required, nullable   | `Option<T>`         | the value, or `null`      |
 * | optional             | `Option<T>`         | the value, or left out    |
 * | optional, nullable   | `Option<Option<T>>` | value, `null`, or left out |
 * | optional with a default | `T`              | the value                 |
 *
 * @module
 */

import {
  type Definition,
  type FieldNode,
  type NamedDefinition,
  type ObjectDefinition,
  pascalCase,
  type Scalar,
  type TypeGraph,
  type TypeNode,
  withoutNull,
} from "../contract/types.ts";

/** Words Rust reserves; a field of that name gets a trailing underscore. */
const KEYWORDS: ReadonlySet<string> = new Set([
  "as",
  "break",
  "const",
  "continue",
  "crate",
  "else",
  "enum",
  "extern",
  "false",
  "fn",
  "for",
  "if",
  "impl",
  "in",
  "let",
  "loop",
  "match",
  "mod",
  "move",
  "mut",
  "pub",
  "ref",
  "return",
  "self",
  "static",
  "struct",
  "super",
  "trait",
  "true",
  "type",
  "unsafe",
  "use",
  "where",
  "while",
  "async",
  "await",
  "dyn",
  "abstract",
  "become",
  "box",
  "do",
  "final",
  "macro",
  "override",
  "priv",
  "typeof",
  "unsized",
  "virtual",
  "yield",
  "try",
  "gen",
]);

/** `usersRetrieve`, `data-id` as `users_retrieve`, `data_id`. */
export function snakeCase(name: string): string {
  const snake = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  const safe = /^[0-9]/.test(snake) ? `_${snake}` : snake || "_";
  return KEYWORDS.has(safe) ? `${safe}_` : safe;
}

/** `usersRetrieve` as `USERS_RETRIEVE`. */
export function constantCase(name: string): string {
  return snakeCase(name).replace(/_$/, "").toUpperCase();
}

/**
 * A string as a Rust raw string literal, with as many `#` as it takes for
 * the text not to end it.
 */
export function rawString(text: string): string {
  let hashes = 1;
  for (const match of text.matchAll(/"(#+)/g)) {
    hashes = Math.max(hashes, match[1].length + 1);
  }
  const fence = "#".repeat(hashes);
  return `r${fence}"${text}"${fence}`;
}

/** A name for an enum variant made from a literal value. */
function variantName(value: Scalar): string {
  const name = pascalCase(String(value)).replace(/^_/, "V");
  return name === "" || name === "_" ? "Empty" : name;
}

/** Renders the definitions of a `TypeGraph` as Rust source. */
export class RustModels {
  /** Enums for literals and unions, defined when a type first needs one. */
  private readonly enums: string[][] = [];
  private readonly enumNames = new Map<string, string>();
  private readonly taken = new Set<string>();

  constructor(private readonly graph: TypeGraph) {}

  /**
   * The Rust type of a node.
   *
   * @param node The type.
   * @param indirect Whether the type sits inside a `Vec` or a map, where
   * a reference to an enclosing type needs no `Box`.
   */
  type(node: TypeNode, indirect = false): string {
    switch (node.kind) {
      case "any":
        return "Value";
      case "null":
        return "()";
      case "boolean":
        return "bool";
      case "string":
        return "String";
      case "integer":
        return "i64";
      case "number":
        return "f64";
      case "literal":
        return this.literal(node.name, node.values);
      case "array":
        return `Vec<${this.type(node.items, true)}>`;
      case "tuple":
        return `(${node.items.map((item) => this.type(item)).join(", ")}${
          node.items.length === 1 ? "," : ""
        })`;
      case "map":
        return `BTreeMap<String, ${this.type(node.values, true)}>`;
      case "union": {
        const { type, nullable } = withoutNull(node);
        if (nullable) return `Option<${this.type(type, indirect)}>`;
        return this.union(node.name, node.variants, node.discriminator);
      }
      case "ref":
        return node.cyclic && !indirect ? `Box<${node.name}>` : node.name;
    }
  }

  /** The source of every definition, then of the enums they use. */
  render(): string[] {
    const lines: string[] = [];
    for (const definition of this.graph.definitions) {
      lines.push(...this.definition(definition), "");
    }
    for (const body of this.enums) lines.push(...body, "");
    return lines;
  }

  // ---------------------------------------------------------------------------

  private unique(name: string): string {
    let candidate = name;
    const used = (n: string) =>
      this.taken.has(n) || this.graph.definitions.some((d) => d.name === n);
    for (let i = 2; used(candidate); i++) candidate = `${name}${i}`;
    this.taken.add(candidate);
    return candidate;
  }

  /**
   * An enum that exists under another name: the same values in another
   * place. The place gets its own name for it, as objects do.
   */
  private also(hint: string, existing: string): string {
    if (hint === existing) return existing;
    const known = this.enumNames.get(`alias:${hint}`);
    if (known !== undefined) return known === existing ? hint : existing;
    const free = !this.taken.has(hint) &&
      !this.graph.definitions.some((d) => d.name === hint);
    if (!free) return existing;
    this.taken.add(hint);
    this.enumNames.set(`alias:${hint}`, existing);
    this.enums.push([
      `/// The same type as [\`${existing}\`].`,
      `pub type ${hint} = ${existing};`,
    ]);
    return hint;
  }

  /** A set of literal values: an enum when they are all strings. */
  private literal(hint: string, values: readonly Scalar[]): string {
    if (!values.every((value) => typeof value === "string")) {
      if (values.every((value) => typeof value === "boolean")) return "bool";
      if (values.every((value) => Number.isInteger(value))) return "i64";
      if (values.every((value) => typeof value === "number")) return "f64";
      return "Value";
    }
    const key = `literal:${JSON.stringify(values)}`;
    const existing = this.enumNames.get(key);
    if (existing) return this.also(hint, existing);

    const name = this.unique(hint);
    this.enumNames.set(key, name);
    const used = new Set<string>();
    const variants = values.map((value) => {
      let variant = variantName(value);
      for (let i = 2; used.has(variant); i++) {
        variant = `${variantName(value)}${i}`;
      }
      used.add(variant);
      return { variant, value: value as string };
    });
    // A type with one value has an obvious default: the value.
    const single = variants.length === 1;
    this.enums.push([
      `/// ${
        single
          ? `The value ${JSON.stringify(values[0])}.`
          : `One of ${values.map((v) => JSON.stringify(v)).join(", ")}.`
      }`,
      `#[derive(Debug, Clone, Copy, PartialEq, Eq${
        single ? ", Default" : ""
      }, Serialize, Deserialize)]`,
      `pub enum ${name} {`,
      ...variants.flatMap(({ variant, value }) => [
        ...(single ? ["    #[default]"] : []),
        `    #[serde(rename = ${JSON.stringify(value)})]`,
        `    ${variant},`,
      ]),
      "}",
    ]);
    return name;
  }

  /** One of several types: an enum that reads whichever variant fits. */
  private union(
    hint: string,
    variants: readonly TypeNode[],
    discriminator: string | undefined,
  ): string {
    // A variant that is an enclosing type is held in a `Box`: the enum
    // is part of that type.
    const types = variants.map((variant) => this.type(variant));
    const key = `union:${types.join("|")}`;
    const existing = this.enumNames.get(key);
    if (existing) return this.also(hint, existing);

    const name = this.unique(hint);
    this.enumNames.set(key, name);
    this.enums.push(this.enumOf(name, variants, types, discriminator));
    return name;
  }

  /** The source of an untagged enum with one variant per type. */
  private enumOf(
    name: string,
    variants: readonly TypeNode[],
    types: readonly string[],
    discriminator: string | undefined,
  ): string[] {
    const used = new Set<string>();
    const named = variants.map((variant, i) => {
      let base = this.variantOf(variant, discriminator) ?? `Variant${i + 1}`;
      if (used.has(base)) base = `Variant${i + 1}`;
      used.add(base);
      // Null carries nothing: a variant without a value is written `null`.
      return variant.kind === "null"
        ? `    ${base},`
        : `    ${base}(${types[i]}),`;
    });
    return [
      `/// One of ${variants.length} alternatives${
        discriminator ? `, told apart by \`${discriminator}\`` : ""
      }.`,
      "#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]",
      "#[serde(untagged)]",
      `pub enum ${name} {`,
      ...named,
      "}",
    ];
  }

  /**
   * A type that refers to itself. A union is an enum of that name, and
   * the references to it from inside are behind a `Vec`, a map or a
   * `Box`. Anything else is a struct around the type.
   */
  private named(definition: NamedDefinition): string[] {
    const { type } = definition;
    if (type.kind === "union") {
      const types = type.variants.map((variant) => this.type(variant, true));
      return this.enumOf(
        definition.name,
        type.variants,
        types,
        type.discriminator,
      );
    }
    return [
      "#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]",
      "#[serde(transparent)]",
      `pub struct ${definition.name}(pub ${this.type(type, true)});`,
    ];
  }

  /** A name for the variant of a union that holds this type. */
  private variantOf(
    variant: TypeNode,
    discriminator: string | undefined,
  ): string | undefined {
    switch (variant.kind) {
      case "null":
        return "Null";
      case "string":
        return "Text";
      case "integer":
        return "Integer";
      case "number":
        return "Number";
      case "boolean":
        return "Boolean";
      case "array":
      case "tuple":
        return "List";
      case "map":
        return "Map";
      case "ref": {
        // The value of the field that tells the variants apart.
        const tag = discriminator &&
          this.graph.object(variant.name)?.fields.find((field) =>
            field.name === discriminator
          );
        if (tag && tag.type.kind === "literal") {
          return variantName(tag.type.values[0]);
        }
        return undefined;
      }
      default:
        return undefined;
    }
  }

  private definition(definition: Definition): string[] {
    if (definition.kind === "alias") {
      return [
        `/// The same type as [\`${definition.target}\`].`,
        `pub type ${definition.name} = ${definition.target};`,
      ];
    }
    if (definition.kind === "named") return this.named(definition);
    return this.struct(definition);
  }

  private struct(definition: ObjectDefinition): string[] {
    const lines: string[] = [];
    const defaults: string[] = [];
    if (definition.description) {
      for (const line of definition.description.split("\n")) {
        lines.push(`/// ${line}`.trimEnd());
      }
    }
    lines.push("#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]");
    if (definition.closed) lines.push("#[serde(deny_unknown_fields)]");
    lines.push(`pub struct ${definition.name} {`);

    const used = new Set<string>();
    for (const field of definition.fields) {
      let name = snakeCase(field.name);
      for (let i = 2; used.has(name); i++) {
        name = `${snakeCase(field.name)}_${i}`;
      }
      used.add(name);
      lines.push(...this.field(definition, field, name, defaults));
    }
    lines.push("}");
    if (defaults.length > 0) lines.push("", ...defaults);
    return lines;
  }

  private field(
    owner: ObjectDefinition,
    field: FieldNode,
    name: string,
    defaults: string[],
  ): string[] {
    const { type: inner, nullable } = withoutNull(field.type);
    const base = this.type(inner);
    const attributes: string[] = [];
    if (name !== field.name) {
      attributes.push(`rename = ${JSON.stringify(field.name)}`);
    }

    let type: string;
    if (field.default) {
      // A missing field takes the schema's default.
      type = nullable ? `Option<${base}>` : base;
      const fn = `default_${snakeCase(owner.name)}_${name.replace(/_$/, "")}`;
      attributes.push(`default = ${JSON.stringify(fn)}`);
      defaults.push(
        `fn ${fn}() -> ${type} {`,
        `    default_value(${rawString(JSON.stringify(field.default.value))})`,
        "}",
      );
    } else if (field.required) {
      type = nullable ? `Option<${base}>` : base;
    } else if (nullable) {
      // Absent, null and a value are three different things.
      type = `Option<Option<${base}>>`;
      attributes.push(
        "default",
        'deserialize_with = "nullable_member"',
        'skip_serializing_if = "Option::is_none"',
      );
    } else if (this.graph.nullable(inner)) {
      // The type has a value for null of its own, so a null that is
      // there is that value, not an absent field.
      type = `Option<${base}>`;
      attributes.push(
        "default",
        'deserialize_with = "present_member"',
        'skip_serializing_if = "Option::is_none"',
      );
    } else {
      type = `Option<${base}>`;
      attributes.push("default", 'skip_serializing_if = "Option::is_none"');
    }

    return [
      ...(field.description
        ? field.description.split("\n").map((line) =>
          `    /// ${line}`.trimEnd()
        )
        : []),
      ...(attributes.length > 0
        ? [`    #[serde(${attributes.join(", ")})]`]
        : []),
      `    pub ${name}: ${type},`,
    ];
  }
}

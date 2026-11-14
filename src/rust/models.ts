/**
 * Rust types from the types of a contract.
 *
 * The types say what Rust's type system can say: which members there are,
 * which may be absent, which may be null, which strings are allowed, which
 * alternative a value is. What it cannot say (lengths, bounds, patterns)
 * is checked by the runtime against the contract's schema before a value
 * of the type is built, and before one is sent.
 *
 * | The contract                         | In Rust                                    |
 * | ------------------------------------ | ------------------------------------------ |
 * | an object                            | a struct                                   |
 * | a set of strings                     | a fieldless enum                           |
 * | a union told apart by a member       | an enum tagged by that member              |
 * | any other union                      | an untagged enum                           |
 * | a union that refers to itself        | an enum of its own name, `Null` a variant  |
 * | a member that may be absent          | `Option<T>`                                |
 * | a member that may be null            | `Option<T>`                                |
 * | a member that may be absent or null  | `MaybeAbsent<T>`: three states             |
 * | a member with a default              | `T`, and the default when it is absent     |
 * | an integer that is not negative      | `u64`                                      |
 * | a type inside itself                 | `Box<T>`, unless a `Vec` or a map holds it |
 *
 * The source is written as rustfmt writes it.
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
import { rustFloat, rustInteger, rustString } from "./contract.ts";

/** The widest line rustfmt writes. */
const WIDTH = 100;

/** Words Rust reserves. As a name, one is written `r#word`. */
const KEYWORDS: ReadonlySet<string> = new Set([
  "as",
  "break",
  "const",
  "continue",
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
  "static",
  "struct",
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

/** Reserved words that cannot be raw identifiers. */
const NEVER_RAW: ReadonlySet<string> = new Set([
  "self",
  "Self",
  "super",
  "crate",
]);

/** `usersRetrieve`, `data-id` as `users_retrieve`, `data_id`. */
export function snakeCase(name: string): string {
  const snake = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return /^[0-9]/.test(snake) ? `_${snake}` : snake || "_";
}

/** A name as an identifier: a reserved word is written raw. */
export function identifier(name: string): string {
  if (NEVER_RAW.has(name)) return `${name}_`;
  return KEYWORDS.has(name) ? `r#${name}` : name;
}

/** `usersRetrieve` as `USERS_RETRIEVE`. */
export function constantCase(name: string): string {
  return snakeCase(name).toUpperCase();
}

/** A name for an enum variant made from a literal value. */
function variantName(value: Scalar): string {
  // A word in capitals is a word: `ON` is `On`, `userID` is `UserId`.
  const words = String(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((word) => /^[A-Z0-9]+$/.test(word) ? word.toLowerCase() : word);
  const name = pascalCase(words.join(" ")).replace(/^_/, "V");
  return name === "" || name === "_" ? "Empty" : name;
}

/** serde's snake case of a variant: an underscore before each capital. */
function snakeVariant(variant: string): string {
  return [...variant].map((c, i) =>
    i > 0 && c !== c.toLowerCase() ? `_${c.toLowerCase()}` : c.toLowerCase()
  ).join("");
}

/** The names serde gives a variant under each `rename_all` rule. */
const VARIANT_RULES: readonly [string, (variant: string) => string][] = [
  ["lowercase", (v) => v.toLowerCase()],
  ["snake_case", snakeVariant],
  ["kebab-case", (v) => snakeVariant(v).replaceAll("_", "-")],
  ["camelCase", (v) => v[0].toLowerCase() + v.slice(1)],
  ["UPPERCASE", (v) => v.toUpperCase()],
  ["SCREAMING_SNAKE_CASE", (v) => snakeVariant(v).toUpperCase()],
  [
    "SCREAMING-KEBAB-CASE",
    (v) => snakeVariant(v).toUpperCase().replaceAll("_", "-"),
  ],
];

/** serde's Pascal case of a field: a capital after each underscore. */
function pascalField(field: string): string {
  let pascal = "";
  let capitalize = true;
  for (const c of field) {
    if (c === "_") {
      capitalize = true;
    } else if (capitalize) {
      pascal += c.toUpperCase();
      capitalize = false;
    } else {
      pascal += c;
    }
  }
  return pascal;
}

/** The names serde gives a field under each `rename_all` rule. */
const FIELD_RULES: readonly [string, (field: string) => string][] = [
  ["camelCase", (f) => {
    const pascal = pascalField(f);
    return pascal.slice(0, 1).toLowerCase() + pascal.slice(1);
  }],
  ["PascalCase", pascalField],
  ["kebab-case", (f) => f.replaceAll("_", "-")],
  ["SCREAMING_SNAKE_CASE", (f) => f.toUpperCase()],
  ["SCREAMING-KEBAB-CASE", (f) => f.toUpperCase().replaceAll("_", "-")],
];

/**
 * The `rename_all` rule that leaves the fewest names to rename one by
 * one, if it leaves fewer than no rule does.
 *
 * @param names Each Rust name with the name on the wire.
 */
function renameRule(
  names: readonly (readonly [rust: string, wire: string])[],
  rules: readonly [string, (name: string) => string][],
): { rule?: string; renamed: ReadonlySet<string> } {
  const differing = (rename: (name: string) => string) =>
    new Set(
      names.filter(([rust, wire]) => rename(rust) !== wire).map(([rust]) =>
        rust
      ),
    );
  let best: { rule?: string; renamed: ReadonlySet<string> } = {
    renamed: differing((name) => name),
  };
  for (const [rule, rename] of rules) {
    const renamed = differing(rename);
    // The rule itself is an attribute too.
    const now = best.renamed.size + (best.rule ? 1 : 0);
    if (renamed.size + 1 < now) best = { rule, renamed };
  }
  return best;
}

/**
 * A list between brackets on one line if it fits, else an item per line.
 *
 * @param indent The columns the line starts at.
 * @param open What comes before the items, with the opening bracket.
 * @param close The closing bracket and what follows.
 * @param trailing Whether the last item of a broken list has a comma.
 */
export function wrapped(
  indent: number,
  open: string,
  items: readonly string[],
  close: string,
  trailing = true,
): string[] {
  const pad = " ".repeat(indent);
  const line = `${pad}${open}${items.join(", ")}${close}`;
  if (line.length <= WIDTH) return [line];
  return [
    `${pad}${open}`,
    ...items.map((item, i) =>
      `${pad}    ${item}${trailing || i < items.length - 1 ? "," : ""}`
    ),
    `${pad}${close}`,
  ];
}

/** A literal value as documentation shows it. */
function quoted(value: Scalar): string {
  return `\`${JSON.stringify(value)}\``;
}

/** A doc comment, one line of source per line of text. */
export function documentation(text: string, indent = 0): string[] {
  const pad = " ".repeat(indent);
  return text.split("\n").map((line) => `${pad}/// ${line}`.trimEnd());
}

type UnionNode = TypeNode & { readonly kind: "union" };

/** An enum the module defines, for the code that refers to it. */
interface EnumInfo {
  readonly name: string;
  /** The variant of each value, for an enum of string literals. */
  readonly variants?: ReadonlyMap<string, string>;
  /** Its source, written when the module is rendered. */
  readonly lines: () => string[];
}

/** Renders the definitions of a `TypeGraph` as Rust source. */
export class RustModels {
  /** Enums for literals and unions, defined when a type first needs one. */
  private readonly enums: EnumInfo[] = [];
  private readonly enumsByKey = new Map<string, EnumInfo>();
  private readonly enumsByName = new Map<string, EnumInfo>();
  private readonly taken = new Set<string>();
  /** Documentation for definitions that have none of their own. */
  private readonly described = new Map<string, string>();
  /** Types the module's API refers to directly. */
  private readonly roots: TypeNode[] = [];
  /** How often each definition is referred to. */
  private references: Map<string, number> | undefined;
  /** Structs that are the variants of a tagged enum: the tag they omit. */
  private readonly tagged = new Map<string, string>();
  /** Whether a definition can derive `Eq` and `Hash`. */
  private readonly comparable = new Map<string, boolean>();

  /** Whether a type is `MaybeAbsent<T>`. */
  usesMaybeAbsent = false;
  /** Whether a type is a `BTreeMap`. */
  usesMap = false;
  /** Whether a type is a `serde_json::Value`. */
  usesValue = false;

  constructor(private readonly graph: TypeGraph) {}

  /**
   * The Rust type of a node the module's API refers to: a part of a
   * request, a response.
   */
  type(node: TypeNode): string {
    this.roots.push(node);
    return this.typeOf(node);
  }

  /** Documentation for a definition that has no description. */
  describe(name: string, text: string): void {
    if (!this.described.has(name)) this.described.set(name, text);
  }

  /** The source of every definition, then of the enums they use. */
  render(): string[] {
    this.plan();
    const lines: string[] = [];
    for (const definition of this.graph.definitions) {
      lines.push(...this.definition(definition), "");
    }
    // Writing an enum can define another.
    for (let i = 0; i < this.enums.length; i++) {
      lines.push(...this.enums[i].lines(), "");
    }
    return lines;
  }

  // ---------------------------------------------------------------------------

  /**
   * @param indirect Whether the type sits inside a `Vec` or a map, where
   * a reference to an enclosing type needs no `Box`.
   */
  private typeOf(node: TypeNode, indirect = false): string {
    switch (node.kind) {
      case "any":
        this.usesValue = true;
        return "Value";
      case "null":
        return "()";
      case "boolean":
        return "bool";
      case "string":
        return "String";
      case "integer":
        // Not negative: the type says so.
        return (node.minimum ?? -1) >= 0 || (node.exclusiveMinimum ?? -2) >= -1
          ? "u64"
          : "i64";
      case "number":
        return "f64";
      case "literal":
        return this.literal(node.name, node.values);
      case "array":
        return `Vec<${this.typeOf(node.items, true)}>`;
      case "tuple":
        return `(${node.items.map((item) => this.typeOf(item)).join(", ")}${
          node.items.length === 1 ? "," : ""
        })`;
      case "map":
        this.usesMap = true;
        return `BTreeMap<String, ${this.typeOf(node.values, true)}>`;
      case "union": {
        const { type, nullable } = withoutNull(node);
        if (nullable) return `Option<${this.typeOf(type, indirect)}>`;
        return this.union(node);
      }
      case "ref":
        return node.cyclic && !indirect ? `Box<${node.name}>` : node.name;
    }
  }

  private unique(name: string): string {
    let candidate = name;
    const used = (n: string) =>
      this.taken.has(n) || this.graph.definitions.some((d) => d.name === n);
    for (let i = 2; used(candidate); i++) candidate = `${name}${i}`;
    this.taken.add(candidate);
    return candidate;
  }

  private add(key: string, info: EnumInfo): string {
    this.enums.push(info);
    this.enumsByKey.set(key, info);
    this.enumsByName.set(info.name, info);
    return info.name;
  }

  /**
   * An enum that exists under another name: the same values in another
   * place. The place gets its own name for it, as objects do.
   */
  private also(hint: string, existing: EnumInfo): string {
    if (hint === existing.name) return hint;
    const known = this.enumsByName.get(hint);
    if (known) return known === existing ? hint : existing.name;
    const free = !this.taken.has(hint) &&
      !this.graph.definitions.some((d) => d.name === hint);
    if (!free) return existing.name;
    this.taken.add(hint);
    this.enumsByName.set(hint, existing);
    this.enums.push({
      name: hint,
      lines: () => [
        `/// The same type as [\`${existing.name}\`].`,
        `pub type ${hint} = ${existing.name};`,
      ],
    });
    return hint;
  }

  /** A set of literal values: an enum when they are all strings. */
  private literal(hint: string, values: readonly Scalar[]): string {
    if (!values.every((value) => typeof value === "string")) {
      if (values.every((value) => typeof value === "boolean")) return "bool";
      if (values.every((value) => Number.isInteger(value))) return "i64";
      if (values.every((value) => typeof value === "number")) return "f64";
      this.usesValue = true;
      return "Value";
    }
    const key = `literal:${JSON.stringify(values)}`;
    const existing = this.enumsByKey.get(key);
    if (existing) return this.also(hint, existing);

    const name = this.unique(hint);
    const used = new Set<string>();
    const variants = new Map<string, string>();
    for (const value of values as string[]) {
      let variant = variantName(value);
      for (let i = 2; used.has(variant); i++) {
        variant = `${variantName(value)}${i}`;
      }
      used.add(variant);
      variants.set(value, variant);
    }
    const { rule, renamed } = renameRule(
      [...variants].map(([value, variant]) => [variant, value] as const),
      VARIANT_RULES,
    );
    // A type with one value has an obvious default: the value.
    const single = variants.size === 1;
    const derives = [
      "Debug",
      "Clone",
      "Copy",
      "PartialEq",
      "Eq",
      "Hash",
      ...(single ? ["Default"] : []),
      "Serialize",
      "Deserialize",
    ];
    return this.add(key, {
      name,
      variants,
      lines: () => [
        `/// ${
          single
            ? `The value ${quoted(values[0])}.`
            : `One of ${values.map(quoted).join(", ")}.`
        }`,
        `#[derive(${derives.join(", ")})]`,
        ...(rule ? [`#[serde(rename_all = "${rule}")]`] : []),
        `pub enum ${name} {`,
        ...[...variants].flatMap(([value, variant]) => [
          ...(single ? ["    #[default]"] : []),
          ...(renamed.has(variant)
            ? [`    #[serde(rename = ${rustString(value)})]`]
            : []),
          `    ${variant},`,
        ]),
        "}",
      ],
    });
  }

  /** One of several types: an enum with a variant for each. */
  private union(node: UnionNode): string {
    // A variant that is an enclosing type is held in a `Box`: the enum
    // is part of that type.
    const types = node.variants.map((variant) => this.typeOf(variant));
    const key = `union:${node.discriminator ?? ""}:${types.join("|")}`;
    const existing = this.enumsByKey.get(key);
    if (existing) return this.also(node.name, existing);

    const name = this.unique(node.name);
    return this.add(key, {
      name,
      lines: () => this.enumOf(name, node, types),
    });
  }

  /** The source of an enum with one variant per alternative. */
  private enumOf(
    name: string,
    node: UnionNode,
    types: readonly string[],
  ): string[] {
    const tag = this.tagOf(node);
    const used = new Set<string>();
    const variants = node.variants.map((variant, i) => {
      let base = this.variantOf(variant, node.tag) ?? `Variant${i + 1}`;
      if (used.has(base)) base = `Variant${i + 1}`;
      used.add(base);
      return base;
    });

    // The value of the tag that selects each variant.
    const values = tag
      ? node.variants.map((variant) => this.tagValue(variant, tag)!)
      : [];
    const { rule, renamed } = tag
      ? renameRule(
        variants.map((variant, i) => [variant, values[i]] as const),
        VARIANT_RULES,
      )
      : { rule: undefined, renamed: new Set<string>() };

    const derives = [
      "Debug",
      "Clone",
      "PartialEq",
      ...(node.variants.every((variant) => this.isComparable(variant))
        ? ["Eq", "Hash"]
        : []),
      "Serialize",
      "Deserialize",
    ];
    const attributes = tag
      ? [
        `tag = ${rustString(tag)}`,
        ...(rule ? [`rename_all = "${rule}"`] : []),
      ]
      : ["untagged"];
    return [
      ...documentation(
        this.described.get(name) ??
          `One of ${node.variants.length} alternatives${
            tag ? `, told apart by \`${tag}\`` : ""
          }.`,
      ),
      `#[derive(${derives.join(", ")})]`,
      ...wrapped(0, "#[serde(", attributes, ")]", false),
      `pub enum ${name} {`,
      ...node.variants.flatMap((variant, i) => [
        ...(tag && renamed.has(variants[i])
          ? [`    #[serde(rename = ${rustString(values[i])})]`]
          : []),
        // Null carries nothing: a variant without a value is written
        // `null`.
        variant.kind === "null"
          ? `    ${variants[i]},`
          : `    ${variants[i]}(${types[i]}),`,
      ]),
      "}",
    ];
  }

  /**
   * The member a union is tagged by, if serde can read the tag itself:
   * every variant is a struct that nothing else refers to, so the struct
   * can leave the tag to the enum.
   */
  private tagOf(node: UnionNode): string | undefined {
    const tag = node.discriminator;
    const references = this.references;
    if (!tag || !references) return undefined;
    const structs = node.variants.map((variant) =>
      variant.kind === "ref" && !variant.cyclic
        ? this.graph.definitions.find((d) => d.name === variant.name)
        : undefined
    );
    const exclusive = structs.every((struct) =>
      struct?.kind === "object" && references.get(struct.name) === 1 &&
      (this.tagged.get(struct.name) ?? tag) === tag
    );
    if (!exclusive) return undefined;
    for (const struct of structs) this.tagged.set(struct!.name, tag);
    return tag;
  }

  /** The value a variant has for the member that tells variants apart. */
  private tagValue(variant: TypeNode, tag: string): string | undefined {
    if (variant.kind !== "ref") return undefined;
    const field = this.graph.object(variant.name)?.fields.find((f) =>
      f.name === tag
    );
    const value = field?.type.kind === "literal"
      ? field.type.values[0]
      : undefined;
    return typeof value === "string" ? value : undefined;
  }

  /** A name for the variant of a union that holds this type. */
  private variantOf(
    variant: TypeNode,
    tag: string | undefined,
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
        const value = tag && this.tagValue(variant, tag);
        return value ? variantName(value) : undefined;
      }
      default:
        return undefined;
    }
  }

  /**
   * Counts the references to each definition and decides which unions are
   * tagged enums, before the structs they hold are written.
   */
  private plan(): void {
    const references = new Map<string, number>();
    const unions: UnionNode[] = [];
    const walk = (node: TypeNode): void => {
      switch (node.kind) {
        case "ref":
          references.set(node.name, (references.get(node.name) ?? 0) + 1);
          return;
        case "array":
          return walk(node.items);
        case "tuple":
          return node.items.forEach(walk);
        case "map":
          return walk(node.values);
        case "union":
          unions.push(node);
          return node.variants.forEach(walk);
      }
    };
    for (const definition of this.graph.definitions) {
      if (definition.kind === "alias") {
        walk({ kind: "ref", name: definition.target, cyclic: false });
      } else if (definition.kind === "named") {
        walk(definition.type);
      } else {
        definition.fields.forEach((field) => walk(field.type));
      }
    }
    this.roots.forEach(walk);
    this.references = references;
    for (const union of unions) this.tagOf(union);
  }

  /** Whether a type can be compared and hashed: it holds no float. */
  private isComparable(node: TypeNode, seen = new Set<string>()): boolean {
    switch (node.kind) {
      case "any":
      case "number":
        return false;
      case "literal":
        return node.values.every((value) =>
          typeof value !== "number" || Number.isInteger(value)
        );
      case "array":
        return this.isComparable(node.items, seen);
      case "tuple":
        return node.items.every((item) => this.isComparable(item, seen));
      case "map":
        return this.isComparable(node.values, seen);
      case "union":
        return node.variants.every((variant) =>
          this.isComparable(variant, seen)
        );
      case "ref": {
        const known = this.comparable.get(node.name);
        if (known !== undefined) return known;
        // Inside itself: nothing new to find.
        if (seen.has(node.name)) return true;
        const definition = this.graph.definitions.find((d) =>
          d.name === node.name
        );
        const inner = new Set([...seen, node.name]);
        const result = !definition
          ? false
          : definition.kind === "alias"
          ? this.isComparable(
            { kind: "ref", name: definition.target, cyclic: false },
            inner,
          )
          : definition.kind === "named"
          ? this.isComparable(definition.type, inner)
          : definition.fields.every((field) =>
            this.isComparable(field.type, inner)
          );
        if (seen.size === 0) this.comparable.set(node.name, result);
        return result;
      }
      default:
        return true;
    }
  }

  private derives(name: string, more: readonly string[] = []): string {
    const self: TypeNode = { kind: "ref", name, cyclic: false };
    return `#[derive(${
      [
        "Debug",
        "Clone",
        "PartialEq",
        ...(this.isComparable(self) ? ["Eq", "Hash"] : []),
        ...more,
        "Serialize",
        "Deserialize",
      ].join(", ")
    })]`;
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

  /**
   * A type that refers to itself. A union is an enum of that name, and
   * the references to it from inside are behind a `Vec`, a map or a
   * `Box`. Anything else is a struct around the type.
   */
  private named(definition: NamedDefinition): string[] {
    const { type } = definition;
    if (type.kind === "union") {
      const types = type.variants.map((variant) => this.typeOf(variant, true));
      return this.enumOf(definition.name, type, types);
    }
    return [
      ...documentation(this.described.get(definition.name) ?? ""),
      this.derives(definition.name),
      "#[serde(transparent)]",
      `pub struct ${definition.name}(pub ${this.typeOf(type, true)});`,
    ].filter((line) => line !== "///");
  }

  private struct(definition: ObjectDefinition): string[] {
    const tag = this.tagged.get(definition.name);
    const fields = definition.fields.filter((field) => field.name !== tag);

    const used = new Set<string>();
    const names = fields.map((field) => {
      // A public field that begins with an underscore reads as unused.
      const snake = snakeCase(field.name).replace(/^_(?=\d)/, "field_");
      let name = snake;
      for (let i = 2; used.has(name); i++) name = `${snake}_${i}`;
      used.add(name);
      return name;
    });
    // serde reads a raw identifier as the word. A word that cannot be
    // raw has another name, which serde is always told (the mark keeps
    // it from fitting a rule).
    const serdeName = (name: string) =>
      NEVER_RAW.has(name) ? `\0${name}` : name;
    const { rule, renamed } = renameRule(
      names.map((name, i) => [serdeName(name), fields[i].name] as const),
      FIELD_RULES,
    );

    const defaults: string[] = [];
    const rendered = fields.map((field, i) =>
      this.field(
        definition,
        field,
        names[i],
        renamed.has(serdeName(names[i])),
        defaults,
      )
    );
    // With no member that has to be given, the type has a default: every
    // member absent, or at the default the contract gives it.
    const optional = fields.every((field) => !field.required);
    const plain = fields.every((field) => !field.default);
    // Not `deny_unknown_fields`: the runtime refuses members a closed
    // object does not name, and reports them with every other issue.
    const attributes = rule ? [`rename_all = "${rule}"`] : [];

    const described = definition.description ??
      this.described.get(definition.name);
    const lines = [
      ...(described ? documentation(described) : []),
      this.derives(definition.name, optional && plain ? ["Default"] : []),
      ...(attributes.length > 0
        ? wrapped(0, "#[serde(", attributes, ")]", false)
        : []),
      ...(fields.length === 0 ? [`pub struct ${definition.name} {}`] : [
        `pub struct ${definition.name} {`,
        ...rendered.flatMap((field) => field.lines),
        "}",
      ]),
    ];

    if (optional && !plain) {
      lines.push(
        "",
        `impl Default for ${definition.name} {`,
        "    fn default() -> Self {",
        "        Self {",
        ...rendered.map((field) =>
          `            ${field.name}: ${field.initial},`
        ),
        "        }",
        "    }",
        "}",
      );
    }
    if (defaults.length > 0) lines.push("", ...defaults);
    return lines;
  }

  private field(
    owner: ObjectDefinition,
    field: FieldNode,
    snake: string,
    rename: boolean,
    defaults: string[],
  ): { name: string; initial: string; lines: string[] } {
    const name = identifier(snake);
    const { type: inner, nullable } = withoutNull(field.type);
    const base = this.typeOf(inner);
    const attributes: string[] = [];
    if (rename) attributes.push(`rename = ${rustString(field.name)}`);

    let type: string;
    let initial = "None";
    if (field.default) {
      // A missing member takes the contract's default.
      type = nullable ? `Option<${base}>` : base;
      const fn = `default_${snakeCase(owner.name)}_${snake}`;
      attributes.push(`default = "${fn}"`);
      initial = `${fn}()`;
      defaults.push(
        ...(defaults.length > 0 ? [""] : []),
        `fn ${fn}() -> ${type} {`,
        `    ${this.expression(field.type, field.default.value)}`,
        "}",
      );
    } else if (field.required) {
      type = nullable ? `Option<${base}>` : base;
    } else if (nullable) {
      // Absent, null and a value are three different things.
      this.usesMaybeAbsent = true;
      type = `MaybeAbsent<${base}>`;
      initial = "MaybeAbsent::Absent";
      attributes.push(
        "default",
        'skip_serializing_if = "MaybeAbsent::is_absent"',
      );
    } else if (this.graph.nullable(inner)) {
      // The type has a value for null of its own, so a null that is
      // there is that value, not an absent member.
      type = `Option<${base}>`;
      attributes.push(
        "default",
        'deserialize_with = "runtime::present_member"',
        'skip_serializing_if = "Option::is_none"',
      );
    } else {
      type = `Option<${base}>`;
      attributes.push("default", 'skip_serializing_if = "Option::is_none"');
    }

    return {
      name,
      initial,
      lines: [
        ...(field.description ? documentation(field.description, 4) : []),
        ...(attributes.length > 0
          ? wrapped(4, "#[serde(", attributes, ")]", false)
          : []),
        `    pub ${name}: ${type},`,
      ],
    };
  }

  /** A default of the contract as a Rust expression of the member's type. */
  private expression(node: TypeNode, value: unknown): string {
    const { type, nullable } = withoutNull(node);
    if (nullable) {
      return value === null ? "None" : `Some(${this.expression(type, value)})`;
    }
    switch (type.kind) {
      case "boolean":
        if (typeof value === "boolean") return String(value);
        break;
      case "integer":
        if (Number.isInteger(value)) return rustInteger(value as number);
        break;
      case "number":
        if (typeof value === "number") return rustFloat(value);
        break;
      case "string":
        if (typeof value === "string") {
          return `String::from(${rustString(value)})`;
        }
        break;
      case "literal": {
        const name = this.literal(type.name, type.values);
        const variant = typeof value === "string"
          ? this.enumsByName.get(name)?.variants?.get(value)
          : undefined;
        if (variant) return `${name}::${variant}`;
        if (typeof value === "boolean") return String(value);
        if (Number.isInteger(value)) return rustInteger(value as number);
        break;
      }
      case "array":
        if (Array.isArray(value)) {
          return value.length === 0
            ? "Vec::new()"
            : `vec![${
              value.map((item) => this.expression(type.items, item)).join(", ")
            }]`;
        }
        break;
    }
    // Anything else is read from the JSON the contract gives.
    return `runtime::default_value(${rustString(JSON.stringify(value))})`;
  }
}

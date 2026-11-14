/**
 * JSON Schema to Pydantic models.
 *
 * Renders the schemas of a contract as Python source: a model class for
 * every object, and a type expression for everything else. What a Zod
 * schema checks is kept where Pydantic can state it: lengths, bounds,
 * patterns, literals, closed objects.
 *
 * Choices that keep the wire the same on both sides:
 *
 * - A string with a format (`date-time`, `uuid`) stays a `str` with its
 *   pattern. Parsing it into a `datetime` and writing it back can change
 *   the text.
 * - A field that may be absent is `T | None = None`; responses are
 *   written without the fields that were not set, so absent stays absent.
 *
 * And the module is written as Python is written (`ruff format` leaves it
 * alone, `ruff check` with every rule has nothing to say):
 *
 * - An attribute is in snake case and has an alias for its name on the
 *   wire. When most names are camel case the models share Pydantic's
 *   `to_camel` alias generator, and only the exceptions say their alias.
 * - What a member has to satisfy is in its `Field(...)`, not in an
 *   `Annotated[...]` around its type, unless the type is inside another.
 * - What the models have in common is in base classes, defined once.
 * - A long pattern is a constant with a name.
 * - Every class has a docstring: the description of its schema, or where
 *   the class is used.
 *
 * @module
 */

import type { JsonSchema } from "../contract/index.ts";
import { canonical } from "../contract/types.ts";
import {
  assignment,
  docstring,
  splitTop,
  stringConstant,
  stringLiteral,
} from "./format.ts";

/** Python keywords and names a Pydantic model already uses. */
const RESERVED: ReadonlySet<string> = new Set([
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
  "match",
  "case",
  "type",
  "self",
  "copy",
  "dict",
  "json",
  "schema",
  "validate",
  "construct",
  "parse_obj",
  "parse_raw",
  "from_orm",
]);

/** The largest integer Zod's `int()` accepts: `Number.MAX_SAFE_INTEGER`. */
const SAFE_INTEGER = 9007199254740991;

/** `usersRetrieve`, `users-list`, `user_posts` as `UsersRetrieve`... */
export function pascalCase(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== "");
  const joined = words
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join("");
  return /^[0-9]/.test(joined) ? `_${joined}` : joined || "_";
}

/** `usersRetrieve` as `users_retrieve`. */
export function snakeCase(name: string): string {
  const snake = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  const safe = /^[0-9]/.test(snake) ? `_${snake}` : snake || "_";
  return RESERVED.has(safe) ? `${safe}_` : safe;
}

/** Names of Python's own that an argument should not take. */
const BUILTINS: ReadonlySet<string> = new Set([
  "all",
  "any",
  "bytes",
  "dir",
  "filter",
  "format",
  "hash",
  "help",
  "id",
  "input",
  "iter",
  "len",
  "list",
  "map",
  "max",
  "min",
  "next",
  "object",
  "open",
  "print",
  "range",
  "set",
  "str",
  "sum",
  "type",
  "vars",
  "zip",
]);

/** The name of an argument for a value called `name`: `id` is `id_`. */
export function argumentName(name: string): string {
  const snake = snakeCase(name);
  return BUILTINS.has(snake) ? `${snake}_` : snake;
}

/** A JSON value as a Python literal. */
export function pythonLiteral(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") return String(value);
  // A JSON string literal is a Python string literal, except for the
  // characters JSON leaves alone and Python reads as escapes.
  if (typeof value === "string") {
    const double = JSON.stringify(value);
    // The quotes that need no escape, as the formatter chooses them.
    return value.includes('"') && !value.includes("'")
      ? `'${double.slice(1, -1).replaceAll('\\"', '"')}'`
      : double;
  }
  if (Array.isArray(value)) return `[${value.map(pythonLiteral).join(", ")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([key, member]) => `${JSON.stringify(key)}: ${pythonLiteral(member)}`);
  return `{${entries.join(", ")}}`;
}

/** The attribute a field is: its wire name in snake case, usable in Python. */
function attributeName(wireName: string): string {
  const snake = wireName
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  const named = snake === "" || /^[0-9]/.test(snake) ? `field_${snake}` : snake;
  // `model_` is where Pydantic keeps its own names.
  return RESERVED.has(named) || named.startsWith("model_")
    ? `${named}_`
    : named;
}

/** What Pydantic's `to_camel` makes of an attribute it is sure about. */
function camelCase(attribute: string): string | undefined {
  if (/^[a-z]+$/.test(attribute)) return attribute;
  if (!/^[a-z]+(_[a-z]+)+$/.test(attribute)) return undefined;
  return attribute.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

/** `a`, `a and b`, `a, b and c`. */
function listed(items: readonly string[]): string {
  return items.length <= 1
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

type Schema = Readonly<Record<string, unknown>>;

/**
 * `_pattern()`, written when a member has a pattern. A pattern of the
 * contract is JavaScript's and stays as it is written there: the module
 * shows it in messages and descriptions. It is compiled once, as Python
 * reads it the same way. (The text is raw: it has no backtick.)
 */
const PATTERN = String.raw`
@functools.cache
def _pattern(source: str) -> re.Pattern[str]:
    r"""Compile a pattern of the API as JavaScript reads it.

    There the classes for digits and for word characters are ASCII, and $ is
    the end of the text. Here $ is also before a line break that ends the
    text, and \Z is the end.
    """
    # An escape and a class are kept as they are: a $ in one is no end.
    ends = re.sub(
        r"\\.|\[(?:\\.|[^\]])*\]|\$",
        lambda found: r"\Z" if found[0] == "$" else found[0],
        source,
        flags=re.DOTALL,
    )
    return re.compile(ends, re.ASCII)
`.trim();

/**
 * `_is_none()`, written when a member may be left out and null is not a
 * value of it. Python has one way to say that something is not there.
 */
const IS_NONE = `
def _is_none(value: object) -> bool:
    """Whether a member that may be left out is left out.

    None is how Python says that it is, and such a member is not written.
    Where null is a value of a member, None is that value: the member is
    written as null when it was set to None, and not at all when it was
    not set.
    """
    return value is None
`.trim();

/** A member of a model class. */
interface FieldInfo {
  /** The name on the wire. */
  readonly wire: string;
  readonly attribute: string;
  /** The annotation, with names not yet defined marked. */
  readonly type: string;
  /** The value a missing member takes, as Python writes it. */
  readonly fallback?: string;
  /** What the member has to satisfy: arguments of its `Field(...)`. */
  readonly constraints: readonly string[];
  readonly description?: string;
}

/** A model class the module defines. */
interface ClassInfo {
  readonly kind: "class";
  readonly name: string;
  /** Whether values keep their JSON type (a body, a response). */
  readonly strict: boolean;
  readonly description?: string;
  readonly fields: readonly FieldInfo[];
  /** Whether the class refers to itself or to a class defined later. */
  readonly rebuild: boolean;
}

/** Something the module defines. */
type Definition =
  | ClassInfo
  /** Another name for a class: the same object in another place. */
  | { readonly kind: "alias"; readonly name: string; readonly target: string }
  /** A type that refers to itself. */
  | { readonly kind: "type"; readonly name: string; readonly text: string };

/** The base classes of the models, by what they add to the one before. */
const BASES = {
  model: {
    name: "_Model",
    parent: "BaseModel",
    doc: "What every model of this module has in common.",
  },
  json: {
    name: "_Json",
    parent: "_Model",
    doc: "A model of JSON: a value keeps the type it has there.",
  },
} as const;

type BaseKey = keyof typeof BASES;

/** One schema document: its root and the definitions it refers to. */
interface Document {
  readonly root: Schema;
  readonly rootName: string;
  readonly defs: Readonly<Record<string, Schema>>;
}

/**
 * Collects the Python definitions for a set of schemas.
 *
 * `define(name, schema)` returns the Python type expression for the
 * schema and records the classes it needs. `render()` gives the source of
 * every class, in an order in which each is defined before it is used.
 */
export class PythonModels {
  private readonly definitions: Definition[] = [];
  private readonly names = new Set<string>();
  /** Named `$defs` by name: their content, to tell a reuse from a clash. */
  private readonly shared = new Map<string, string>();
  /**
   * Object schemas already rendered, by content: the same schema under
   * another name is that class again, not a second one.
   */
  private readonly rendered = new Map<string, string>();
  /** The classes of a document's definitions that Zod named itself. */
  private readonly unnamed = new Map<Document, Map<string, string>>();
  /** Classes whose fields are being rendered: a reference is to itself. */
  private readonly building = new Set<string>();
  /** Schemas that are not objects, while their type is worked out. */
  private readonly open = new Map<Schema, { hint: string; name?: string }>();
  /** Types that refer to themselves, by content: their name. */
  private readonly recursive = new Map<string, string>();
  /** Where each class is used: as what, by which operations. */
  private readonly uses = new Map<string, Map<string, string[]>>();
  /** Where a class that is part of another comes from, by its name. */
  private readonly origins = new Map<string, string>();
  /** The constant of each long pattern, by its text. */
  private readonly patterns = new Map<string, string>();
  /** The base classes the models use. */
  private readonly bases = new Set<BaseKey>();
  /** Whether a member has a pattern. */
  private usesPatterns = false;
  /** Whether a member that may be left out is not written when it is None. */
  private usesIsNone = false;
  /** Whether a type expression used `SafeInt`. */
  usesSafeInt = false;
  /** Whether a definition is a `type` statement, which needs Python 3.12. */
  usesTypeStatement = false;

  /**
   * The Python type of a schema, named `name` if it needs a name (an
   * object becomes a class of that name; anything else an expression).
   *
   * @param name Class name for the root, e.g. `NotesUpdateBody`.
   * @param schema A JSON Schema document.
   * @param strict Whether values keep their JSON type (a body), or are
   * coerced from text (query and path parameters).
   */
  define(name: string, schema: JsonSchema, strict: boolean): string {
    const { $defs, $schema: _dialect, ...root } = schema as Schema & {
      $defs?: Record<string, Schema>;
    };
    const document: Document = { root, rootName: name, defs: $defs ?? {} };
    return isObject(root)
      ? this.typeOf(root, name, document, strict)
      : this.expand(root, name, document, strict);
  }

  /**
   * Notes where a type is used, for the docstring of a class whose schema
   * has no description: "The response of `GET /notes/{id}`".
   *
   * @param type A type as `define()` gave it.
   * @param role What it is there: "response", "404 body".
   * @param operation The operation, as documentation names it.
   */
  describe(type: string, role: string, operation: string): void {
    const name = this.target(type);
    let roles = this.uses.get(name);
    if (!roles) this.uses.set(name, roles = new Map());
    roles.set(role, [...(roles.get(role) ?? []), operation]);
  }

  /**
   * The base class for a model the caller writes itself.
   *
   * @param strict Whether its values keep their JSON type.
   */
  base(strict: boolean): string {
    const key: BaseKey = strict ? "json" : "model";
    // A base class is defined after the one it extends.
    this.bases.add("model").add(key);
    return BASES[key].name;
  }

  /** The source of every definition. */
  render(): string[] {
    const classes = this.definitions.filter((d) => d.kind === "class");
    const generated = this.camelCase(classes);
    const lines: string[] = [];
    if (this.usesPatterns) lines.push(PATTERN, "", "");
    for (const [text, name] of this.patterns) {
      lines.push(...stringConstant(0, name, text));
    }
    if (this.patterns.size > 0) lines.push("", "");
    if (this.usesIsNone) lines.push(IS_NONE, "", "");

    for (const key of ["model", "json"] as const) {
      if (!this.bases.has(key)) continue;
      const { name, parent, doc } = BASES[key];
      const config = key === "model"
        ? [
          ...(generated ? ["alias_generator=to_camel"] : []),
          // JSON has no number that is not finite.
          "allow_inf_nan=False",
          "populate_by_name=True",
          'regex_engine="python-re"',
          "use_attribute_docstrings=True",
        ]
        : ["strict=True"];
      lines.push(
        `class ${name}(${parent}):`,
        ...docstring(4, doc),
        "",
        ...assignment(
          4,
          "model_config",
          undefined,
          `ConfigDict(${config.join(", ")})`,
        ),
        "",
        "",
      );
    }

    this.definitions.forEach((definition, i) => {
      if (definition.kind === "alias") {
        lines.push(`${definition.name} = ${definition.target}`);
      } else if (definition.kind === "type") {
        lines.push(
          ...assignment(
            0,
            `type ${definition.name}`,
            undefined,
            definition.text,
          ),
        );
      } else {
        lines.push(...this.classLines(definition, generated));
      }
      // Names for the same class stay together; a class stands apart.
      const next = this.definitions[i + 1];
      if (definition.kind === "class" || next?.kind !== definition.kind) {
        lines.push("", "");
      }
    });
    const rebuilds = classes.filter((d) => d.rebuild);
    if (rebuilds.length > 0) {
      for (const { name } of rebuilds) lines.push(`${name}.model_rebuild()`);
      lines.push("", "");
    }
    return lines;
  }

  /**
   * Whether the models share an alias generator: when more names on the
   * wire are camel case than would then have to say their alias.
   */
  private camelCase(classes: readonly ClassInfo[]): boolean {
    let covered = 0;
    let exceptions = 0;
    for (const { fields } of classes) {
      for (const { wire, attribute } of fields) {
        if (wire === attribute) {
          // With a generator, `created_at` on the wire is an exception.
          if (camelCase(attribute) !== wire) exceptions++;
        } else if (camelCase(attribute) === wire) {
          covered++;
        }
      }
    }
    return covered > exceptions;
  }

  private classLines(definition: ClassInfo, generated: boolean): string[] {
    const { name, strict } = definition;
    const lines = [
      `class ${name}(${this.base(strict)}):`,
      ...this.classDoc(definition),
    ];
    for (const field of definition.fields) {
      const { wire, attribute } = field;
      const expected = generated ? camelCase(attribute) : attribute;
      // A list or a dict as a default is made anew for every instance.
      const made = field.fallback === "[]"
        ? "default_factory=list"
        : field.fallback === "{}"
        ? "default_factory=dict"
        : field.fallback !== undefined && /^[[{]/.test(field.fallback)
        ? `default_factory=lambda: ${field.fallback}`
        : undefined;
      const options = [
        ...(made !== undefined
          ? [made]
          : field.constraints.length > 0 || expected !== wire
          ? (field.fallback === undefined ? [] : [`default=${field.fallback}`])
          : []),
        ...field.constraints,
        // Not `alias`: a type checker would then take the wire name for
        // the constructor's parameter, which Python cannot always spell.
        ...(expected === wire ? [] : [
          `validation_alias=${JSON.stringify(wire)}`,
          `serialization_alias=${JSON.stringify(wire)}`,
        ]),
      ];
      // A class that does not exist yet can only be named in a string,
      // and a string is not a type that `|` or `list[...]` accept
      // everywhere: the whole annotation is the string.
      const type = field.type.includes(FORWARD)
        ? annotation(field.type)
        : field.type;
      lines.push(
        ...(lines.length > 1 && lines.at(-1) !== "" &&
            (field.description !== undefined ||
              lines.at(-1)!.trimStart().startsWith('"""'))
          ? [""]
          : []),
        ...assignment(
          4,
          attribute,
          type,
          options.length > 0 ? `Field(${options.join(", ")})` : field.fallback,
        ),
        ...(field.description === undefined
          ? []
          : docstring(4, field.description, { verbatim: true })),
      );
    }
    return lines;
  }

  /** The docstring of a class: its description, or where it is used. */
  private classDoc(definition: ClassInfo): string[] {
    const { name, description } = definition;
    const used = this.described(name);
    const text = description ?? used?.text ?? this.origins.get(name) ??
      "An object of the API";
    let lines = docstring(4, text);
    if (description === undefined && used && lines.length > 1) {
      lines = docstring(4, `${used.summary}\n\n${used.detail}`);
    }
    return definition.fields.length > 0 ? [...lines, ""] : lines;
  }

  /** "The response of `GET /a` and `PUT /a`; the body of `POST /b`." */
  private described(
    name: string,
  ): { text: string; summary: string; detail: string } | undefined {
    const roles = this.uses.get(name);
    if (!roles) return undefined;
    // Roles the same operations give it are said together.
    const groups = new Map<string, string[]>();
    let count = 0;
    for (const [role, operations] of roles) {
      const of = listed(operations.map((label) => `\`${label}\``));
      if (!groups.has(of)) count += operations.length;
      groups.set(of, [...(groups.get(of) ?? []), role]);
    }
    const parts = [...groups].map(([of, named]) =>
      `the ${listed(named)} of ${of}`
    );
    const text = parts.join("; ");
    const sentence = `${text[0].toUpperCase()}${text.slice(1)}.`;
    return {
      text: sentence,
      // For a list that does not fit on the first line: what it is, then
      // the operations.
      summary: `The ${listed([...roles.keys()])} of ${count} operations.`,
      detail: groups.size === 1 ? `${[...groups.keys()][0]}.` : sentence,
    };
  }

  /** The class a name stands for. */
  private target(name: string): string {
    const definition = this.definitions.find((d) => d.name === name);
    return definition?.kind === "alias" ? this.target(definition.target) : name;
  }

  /** Whether a class of that name was defined. */
  has(name: string): boolean {
    return this.names.has(name);
  }

  // ---------------------------------------------------------------------------

  private unique(name: string): string {
    let candidate = name;
    for (let i = 2; this.names.has(candidate); i++) candidate = `${name}${i}`;
    this.names.add(candidate);
    return candidate;
  }

  private typeOf(
    schema: Schema,
    name: string,
    document: Document,
    strict: boolean,
  ): string {
    // References: the document's own root, or a named definition.
    if (typeof schema.$ref === "string") {
      if (schema.$ref === "#") {
        return isObject(document.root)
          ? forward(document.rootName)
          : this.expand(document.root, document.rootName, document, strict);
      }
      const key = schema.$ref.replace(/^#\/\$defs\//, "");
      const target = document.defs[key];
      if (!target) throw new Error(`Unresolved reference ${schema.$ref}`);
      // A definition Zod named itself (`__schema0`: a schema used twice,
      // or one that refers to itself) is named after where it is used.
      return /^__schema\d+$/.test(key)
        ? this.unnamedType(key, target, name, document, strict)
        : this.sharedType(key, target, document, strict);
    }

    if ("const" in schema) return `Literal[${pythonLiteral(schema.const)}]`;
    if (Array.isArray(schema.enum)) {
      return `Literal[${schema.enum.map(pythonLiteral).join(", ")}]`;
    }

    const alternatives = (schema.anyOf ?? schema.oneOf) as
      | Schema[]
      | undefined;
    if (Array.isArray(alternatives)) {
      return this.unionOf(alternatives, name, document, strict);
    }

    if (Array.isArray(schema.allOf)) {
      const members = schema.allOf as Schema[];
      if (members.length === 1) {
        return this.typeOf(members[0], name, document, strict);
      }
      const merged = mergeObjects(members);
      return merged ? this.typeOf(merged, name, document, strict) : "Any";
    }

    // `type: ["string", "null"]` is a union of plain types.
    if (Array.isArray(schema.type)) {
      const members = (schema.type as string[]).map((type) => ({
        ...schema,
        type,
      }));
      return this.unionOf(members, name, document, strict);
    }

    switch (schema.type) {
      case "null":
        return "None";
      case "boolean":
        return "bool";
      case "string":
        return constrained(
          "str",
          {
            min_length: schema.minLength,
            max_length: schema.maxLength,
          },
          typeof schema.pattern === "string"
            ? [`pattern=${this.pattern(schema.pattern, schema.format)}`]
            : [],
        );
      case "integer":
        return this.integer(schema);
      case "number":
        return constrained("float", bounds(schema));
      case "array":
        return this.arrayOf(schema, name, document, strict);
      case "object":
        return this.objectOf(schema, name, document, strict);
      default:
        // No type: anything.
        return "Any";
    }
  }

  /**
   * A pattern as `Field(pattern=...)` takes it: compiled as JavaScript
   * reads it.
   */
  private pattern(source: string, format: unknown): string {
    return `_pattern(${this.patternText(source, format)})`;
  }

  /**
   * Has `_pattern()` written, for a module that compiles patterns that
   * are not in a model.
   */
  compilesPatterns(): void {
    this.usesPatterns = true;
  }

  /**
   * The text of a pattern, as JavaScript writes it: a literal, or the name
   * of a constant when the text is long or is what a format means.
   */
  patternText(source: string, format: unknown): string {
    this.usesPatterns = true;
    if (typeof format !== "string" && source.length <= 40) {
      return stringLiteral(source);
    }
    const known = this.patterns.get(source);
    if (known !== undefined) return known;
    const base = typeof format === "string"
      ? `_${format.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}_PATTERN`
      : "_PATTERN";
    const taken = new Set(this.patterns.values());
    let name = typeof format === "string" ? base : `${base}_1`;
    for (let i = 2; taken.has(name); i++) name = `${base}_${i}`;
    this.patterns.set(source, name);
    return name;
  }

  private integer(schema: Schema): string {
    const { ge, le, ...rest } = bounds(schema);
    if (
      ge === -SAFE_INTEGER && le === SAFE_INTEGER &&
      Object.values(rest).every((value) => value === undefined)
    ) {
      this.usesSafeInt = true;
      return "SafeInt";
    }
    return constrained("int", { ge, le, ...rest });
  }

  private arrayOf(
    schema: Schema,
    name: string,
    document: Document,
    strict: boolean,
  ): string {
    if (Array.isArray(schema.prefixItems)) {
      const members = (schema.prefixItems as Schema[]).map((member, i) =>
        this.typeOf(member, `${name}Item${i + 1}`, document, strict)
      );
      // JSON has no tuples: an array is what arrives. A strict model takes
      // only a Python tuple for one, so the container is not strict; its
      // members still are.
      return constrained(`tuple[${members.join(", ")}]`, {
        strict: strict ? false : undefined,
      });
    }
    const items = schema.items && typeof schema.items === "object"
      ? this.typeOf(schema.items as Schema, `${name}Item`, document, strict)
      : "Any";
    return constrained(`list[${items}]`, {
      min_length: schema.minItems,
      max_length: schema.maxItems,
    });
  }

  private unionOf(
    alternatives: readonly Schema[],
    name: string,
    document: Document,
    strict: boolean,
  ): string {
    const tag = discriminator(alternatives, document);
    const members = alternatives.map((member, i) => {
      const value = tag && (resolve(member, document).properties as
        | Record<string, Schema>
        | undefined)?.[tag]?.const;
      const suffix = typeof value === "string" ? pascalCase(value) : `${i + 1}`;
      const origin = this.origins.get(name);
      const of = origin
        ? `${origin[0].toLowerCase()}${origin.slice(1)}`
        : `\`${name}\``;
      this.originate(
        `${name}${suffix}`,
        typeof value === "string"
          ? `The alternative \`${value}\` of ${of}`
          : `An alternative of ${of}`,
      );
      return this.typeOf(member, `${name}${suffix}`, document, strict);
    });
    // None is written last, as Python writes an optional type.
    const distinct = [...new Set(members)].sort((a, b) =>
      Number(a === "None") - Number(b === "None")
    );
    const union = distinct.join(" | ");
    return tag && distinct.length > 1
      ? `Annotated[${union}, Field(discriminator=${JSON.stringify(tag)})]`
      : union;
  }

  private unnamedType(
    key: string,
    schema: Schema,
    hint: string,
    document: Document,
    strict: boolean,
  ): string {
    if (!isObject(schema)) return this.expand(schema, hint, document, strict);
    let known = this.unnamed.get(document);
    if (!known) this.unnamed.set(document, known = new Map());
    const existing = known.get(key);
    if (existing !== undefined) {
      return this.building.has(existing) ? forward(existing) : existing;
    }
    // The same object was defined in another document: on the other side
    // of the schema, or in another operation.
    const content = JSON.stringify([
      canonical(schema, document, "closed"),
      strict,
    ]);
    const same = this.rendered.get(content);
    if (same !== undefined && !this.building.has(same)) {
      // Under the name it has here too, as an object written in place is.
      const alias = this.unique(hint);
      this.definitions.push({ kind: "alias", name: alias, target: same });
      known.set(key, alias);
      return alias;
    }
    const name = this.unique(hint);
    known.set(key, name);
    return this.objectOf(schema, name, document, strict, true);
  }

  private sharedType(
    key: string,
    schema: Schema,
    document: Document,
    strict: boolean,
  ): string {
    // An object definition is one class, shared by every document that
    // carries the same definition under the same name.
    if (schema.type === "object" && schema.properties) {
      const name = pascalCase(key);
      const content = JSON.stringify([
        canonical(schema, document, "closed"),
        strict,
      ]);
      const known = this.shared.get(name);
      if (known === content) {
        // Inside its own definition the class does not exist yet.
        return this.building.has(name) ? forward(name) : name;
      }
      if (known !== undefined) {
        throw new Error(
          `Two different schemas are named "${key}"; give one another id`,
        );
      }
      this.shared.set(name, content);
      return this.objectOf(schema, name, document, strict, true);
    }
    return this.expand(schema, pascalCase(key), document, strict);
  }

  /**
   * The type of a schema that is not an object. Written in place, unless
   * the schema refers to itself (a JSON value, an expression): then it is
   * a `type` statement, whose right side may name the type itself.
   */
  private expand(
    schema: Schema,
    hint: string,
    document: Document,
    strict: boolean,
  ): string {
    const content = JSON.stringify([
      canonical(schema, document, "closed"),
      strict,
    ]);
    const known = this.recursive.get(content);
    if (known !== undefined) return known;

    const open = this.open.get(schema);
    if (open) {
      // Reached again from inside itself. A class defined on the way
      // names it before it exists.
      open.name ??= this.unique(open.hint);
      return forward(open.name);
    }

    const entry: { hint: string; name?: string } = { hint };
    this.open.set(schema, entry);
    const type = this.typeOf(schema, hint, document, strict);
    this.open.delete(schema);
    if (entry.name === undefined) return type;

    this.recursive.set(content, entry.name);
    this.usesTypeStatement = true;
    this.definitions.push({
      kind: "type",
      name: entry.name,
      // The right side of a `type` statement is evaluated when it is
      // used, so it names itself and later classes as they are.
      text: type.replaceAll(FORWARD, ""),
    });
    return entry.name;
  }

  private objectOf(
    schema: Schema,
    name: string,
    document: Document,
    strict: boolean,
    named = false,
  ): string {
    const properties = schema.properties as
      | Record<string, Schema>
      | undefined;
    const additional = schema.additionalProperties;

    // No fields: a mapping, typed by what its values may be.
    if (!properties || Object.keys(properties).length === 0) {
      if (additional && typeof additional === "object") {
        const values = this.typeOf(
          additional as Schema,
          `${name}Value`,
          document,
          strict,
        );
        return `dict[str, ${values}]`;
      }
      if (!properties) return "dict[str, Any]";
    }

    // The same object under another name (the note a list returns and the
    // note a retrieval returns) is one class with two names, so a value of
    // one is a value of the other. So are the two sides of a schema, what
    // a request sends and what a response carries, where they ask for the
    // same members: that a response is closed has no bearing on the
    // class, and a handler passes a part of the request on as a part of
    // the response. With a default they are two classes: a request may
    // leave the member out, a response has to have it, and the type of
    // what a handler returns says so.
    const content = JSON.stringify([
      canonical(schema, document, "closed"),
      strict,
    ]);
    if (!named) {
      const same = this.rendered.get(content);
      if (same !== undefined) {
        const alias = this.unique(name);
        this.definitions.push({ kind: "alias", name: alias, target: same });
        return alias;
      }
    }

    const className = named ? name : this.unique(name);
    if (named) this.names.add(className);
    this.rendered.set(content, className);
    this.building.add(className);
    const required = new Set((schema.required as string[] | undefined) ?? []);

    const fields: FieldInfo[] = [];
    const taken = new Set<string>();
    let incomplete = false;
    for (const [wire, member] of Object.entries(properties ?? {})) {
      // Two names that are one name in snake case: the second is numbered.
      const base = attributeName(wire);
      let attribute = base;
      for (let i = 2; taken.has(attribute); i++) attribute = `${base}_${i}`;
      taken.add(attribute);

      const child = `${className}${pascalCase(wire)}`;
      this.originate(child, `The member \`${wire}\` of \`${className}\``);
      let type = this.typeOf(member, child, document, strict);
      // A name that did not exist when the class was made: the class is
      // completed once every definition exists.
      if (type.includes(FORWARD)) incomplete = true;

      // What the member has to satisfy is said by its `Field(...)`.
      const hoisted = hoist(type);
      type = hoisted.type;
      let fallback: string | undefined;
      const constraints = [...hoisted.constraints];
      if (!required.has(wire)) {
        if ("default" in member) {
          fallback = pythonLiteral(member.default);
        } else {
          if (!/(^|\| )None$/.test(type)) type = `${type} | None`;
          fallback = "None";
          // None is how Python says that the member is left out, so it
          // is not written: unless null is a value of the member, which
          // then has three states (not set, None, a value).
          if (!acceptsNull(member, document)) {
            constraints.push("exclude_if=_is_none");
            this.usesIsNone = true;
          }
        }
      }
      fields.push({
        wire,
        attribute,
        type,
        ...(fallback !== undefined && { fallback }),
        constraints,
        ...(typeof member.description === "string" &&
          { description: member.description }),
      });
    }

    // The classes of its fields were defined while they were rendered, so
    // this one comes after them. One that refers to itself by name
    // resolves that name once it exists.
    this.building.delete(className);
    this.base(strict);
    this.definitions.push({
      kind: "class",
      name: className,
      strict,
      ...(typeof schema.description === "string" &&
        { description: schema.description }),
      fields,
      rebuild: incomplete,
    });
    return className;
  }

  /**
   * Notes where a class that is part of another comes from, and where
   * the classes inside it would.
   */
  private originate(name: string, origin: string): void {
    if (this.origins.has(name)) return;
    this.origins.set(name, origin);
    const inner = `${origin[0].toLowerCase()}${origin.slice(1)}`;
    this.origins.set(`${name}Item`, `An item of ${inner}`);
    this.origins.set(`${name}Value`, `A value of ${inner}`);
  }
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Whether null is a value of a schema: then None is that value, and not
 * the absence of the member.
 */
function acceptsNull(
  schema: Schema,
  document: Document,
  seen = new Set<Schema>(),
): boolean {
  const resolved = resolve(schema, document);
  // A reference back to where the question started adds nothing.
  if (seen.has(resolved)) return false;
  seen.add(resolved);
  if ("const" in resolved) return resolved.const === null;
  if (Array.isArray(resolved.enum)) return resolved.enum.includes(null);
  const alternatives = resolved.anyOf ?? resolved.oneOf;
  if (Array.isArray(alternatives)) {
    return alternatives.some((alternative) =>
      acceptsNull(alternative as Schema, document, seen)
    );
  }
  if (Array.isArray(resolved.allOf)) {
    return resolved.allOf.every((part) =>
      acceptsNull(part as Schema, document, seen)
    );
  }
  const types = Array.isArray(resolved.type)
    ? resolved.type
    : typeof resolved.type === "string"
    ? [resolved.type]
    : [];
  // No type: anything, null included.
  return types.length === 0 || types.includes("null");
}

/** Whether a schema becomes a class. */
function isObject(schema: Schema): boolean {
  return schema.type === "object" && schema.properties !== undefined;
}

/** Marks a name that is used before its class exists. */
const FORWARD = "\u0001";

/** A reference to a class that is still being defined. */
function forward(name: string): string {
  return `${FORWARD}${name}${FORWARD}`;
}

/** A type that names a class not yet defined, as a string annotation. */
function annotation(type: string): string {
  const text = type.replaceAll(FORWARD, "");
  if (!text.includes('"')) return `"${text}"`;
  if (!text.includes("'")) return `'${text}'`;
  return JSON.stringify(text);
}

/**
 * `Annotated[T, Field(...)]` when there is a constraint, else `T`.
 *
 * @param more Constraints that are written already.
 */
function constrained(
  type: string,
  constraints: Record<string, unknown>,
  more: readonly string[] = [],
) {
  const stated = [
    ...Object.entries(constraints)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${pythonLiteral(value)}`),
    ...more,
  ];
  return stated.length === 0
    ? type
    : `Annotated[${type}, Field(${stated.join(", ")})]`;
}

/**
 * The type of a member without the constraints around it, and those
 * constraints: `Annotated[str, Field(min_length=1)] | None` is
 * `str | None` and `min_length=1`. Pydantic applies what a field says to
 * the value that is not None.
 */
function hoist(type: string): { type: string; constraints: string[] } {
  const members = splitTop(type, " | ");
  const others = members.filter((member) => member !== "None");
  if (others.length !== 1) return { type, constraints: [] };
  const [only] = others;
  if (!only.startsWith("Annotated[") || !only.endsWith("]")) {
    return { type, constraints: [] };
  }
  const parts = splitTop(only.slice("Annotated[".length, -1), ", ");
  const field = parts.at(-1)!;
  if (parts.length !== 2 || !/^Field\(.*\)$/.test(field)) {
    return { type, constraints: [] };
  }
  return {
    type: members.map((member) => member === only ? parts[0] : member).join(
      " | ",
    ),
    constraints: splitTop(field.slice("Field(".length, -1), ", "),
  };
}

function bounds(schema: Schema): Record<string, unknown> {
  return {
    ge: schema.minimum,
    le: schema.maximum,
    gt: schema.exclusiveMinimum,
    lt: schema.exclusiveMaximum,
    multiple_of: schema.multipleOf,
  };
}

function resolve(schema: Schema, document: Document): Schema {
  if (typeof schema.$ref !== "string") return schema;
  if (schema.$ref === "#") return document.root;
  return document.defs[schema.$ref.replace(/^#\/\$defs\//, "")] ?? schema;
}

/**
 * The property that tells the members of a union apart: every member is an
 * object that requires it with a string constant, and no two constants
 * are equal.
 */
function discriminator(
  alternatives: readonly Schema[],
  document: Document,
): string | undefined {
  if (alternatives.length < 2) return undefined;
  const members = alternatives.map((member) => resolve(member, document));
  if (!members.every((member) => member.type === "object")) return undefined;

  const first = (members[0].properties ?? {}) as Record<string, Schema>;
  for (const key of Object.keys(first)) {
    const values = members.map((member) => {
      const property = (member.properties as Record<string, Schema> | undefined)
        ?.[key];
      const required = (member.required as string[] | undefined) ?? [];
      return property && required.includes(key) &&
          typeof property.const === "string"
        ? property.const
        : undefined;
    });
    if (
      values.every((value) => value !== undefined) &&
      new Set(values).size === values.length
    ) {
      return key;
    }
  }
  return undefined;
}

/** An intersection of object schemas as one object schema. */
function mergeObjects(members: readonly Schema[]): Schema | undefined {
  if (!members.every((member) => member.type === "object")) return undefined;
  return {
    type: "object",
    properties: Object.assign({}, ...members.map((m) => m.properties ?? {})),
    required: [
      ...new Set(members.flatMap((m) => (m.required as string[]) ?? [])),
    ],
  };
}

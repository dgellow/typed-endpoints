/**
 * JSON Schema to Pydantic models.
 *
 * Renders the schemas of a contract as Python source: a `BaseModel` class
 * for every object, and a type expression for everything else. What a Zod
 * schema checks is kept where Pydantic can state it: lengths, bounds,
 * patterns, literals, closed objects.
 *
 * Choices that keep the wire the same on both sides:
 *
 * - A string with a format (`date-time`, `uuid`) stays a `str` with its
 *   pattern. Parsing it into a `datetime` and writing it back can change
 *   the text.
 * - A field keeps its wire name. A name Python cannot use as an attribute
 *   (`from`, `data-id`, `_private`) gets a Python name and an alias.
 * - A field that may be absent is `T | None = None`; responses are
 *   written without the fields that were not set, so absent stays absent.
 *
 * @module
 */

import type { JsonSchema } from "../contract/index.ts";

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

/** A JSON value as a Python literal. */
export function pythonLiteral(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") return String(value);
  // A JSON string literal is a Python string literal, except for the
  // characters JSON leaves alone and Python reads as escapes.
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(pythonLiteral).join(", ")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([key, member]) => `${JSON.stringify(key)}: ${pythonLiteral(member)}`);
  return `{${entries.join(", ")}}`;
}

/** The attribute name a field gets, and whether it differs from the wire name. */
function attributeName(wireName: string): string {
  const usable = /^[A-Za-z][A-Za-z0-9_]*$/.test(wireName) &&
    !RESERVED.has(wireName) && !wireName.startsWith("model_");
  if (usable) return wireName;
  const cleaned = wireName.replace(/[^A-Za-z0-9_]/g, "_").replace(/^_+/, "");
  const named = cleaned === "" || /^[0-9]/.test(cleaned)
    ? `field_${cleaned}`
    : cleaned;
  return RESERVED.has(named) || named.startsWith("model_")
    ? `${named}_`
    : named;
}

type Schema = Readonly<Record<string, unknown>>;

/** A class or alias the module defines. */
interface Definition {
  readonly name: string;
  readonly lines: readonly string[];
  /** Whether the class refers to itself or to a class defined later. */
  readonly rebuild: boolean;
}

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
  /** Whether a type expression used `SafeInt`. */
  usesSafeInt = false;

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
    return this.typeOf(root, name, document, strict);
  }

  /** The source of every definition. */
  render(): string[] {
    const lines: string[] = [];
    for (const definition of this.definitions) {
      lines.push(...definition.lines, "", "");
    }
    const rebuilds = this.definitions.filter((d) => d.rebuild);
    if (rebuilds.length > 0) {
      for (const { name } of rebuilds) lines.push(`${name}.model_rebuild()`);
      lines.push("", "");
    }
    return lines;
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
      if (schema.$ref === "#") return JSON.stringify(document.rootName);
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
        return constrained("str", {
          min_length: schema.minLength,
          max_length: schema.maxLength,
          pattern: schema.pattern,
        });
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
      return `tuple[${members.join(", ")}]`;
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
      return this.typeOf(member, `${name}${suffix}`, document, strict);
    });
    const distinct = [...new Set(members)];
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
    if (schema.type !== "object" || !schema.properties) {
      return this.typeOf(schema, hint, document, strict);
    }
    let known = this.unnamed.get(document);
    if (!known) this.unnamed.set(document, known = new Map());
    const existing = known.get(key);
    if (existing !== undefined) {
      return this.building.has(existing) ? JSON.stringify(existing) : existing;
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
      const content = JSON.stringify([schema, strict]);
      const known = this.shared.get(name);
      if (known === content) {
        // Inside its own definition the class does not exist yet.
        return this.building.has(name) ? JSON.stringify(name) : name;
      }
      if (known !== undefined) {
        throw new Error(
          `Two different schemas are named "${key}"; give one another id`,
        );
      }
      this.shared.set(name, content);
      return this.objectOf(schema, name, document, strict, true);
    }
    return this.typeOf(schema, pascalCase(key), document, strict);
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
    // one is a value of the other.
    // What a reference means depends on the document: its definitions,
    // and for a reference to the root, which schema the root is.
    const text = JSON.stringify(schema);
    const content = JSON.stringify([
      schema,
      strict,
      text.includes('"$ref":"#/') ? document.defs : null,
      text.includes('"$ref":"#"') ? document.rootName : null,
    ]);
    if (!named) {
      const same = this.rendered.get(content);
      if (same !== undefined) {
        const alias = this.unique(name);
        this.definitions.push({
          name: alias,
          lines: [`${alias} = ${same}`],
          rebuild: false,
        });
        return alias;
      }
    }

    const className = named ? name : this.unique(name);
    if (named) this.names.add(className);
    this.rendered.set(content, className);
    this.building.add(className);
    const required = new Set((schema.required as string[] | undefined) ?? []);

    const config = [
      ...(strict ? ["strict=True"] : []),
      ...(additional === false ? ['extra="forbid"'] : []),
      "populate_by_name=True",
      'regex_engine="python-re"',
    ];
    const body: string[] = [];
    if (typeof schema.description === "string") {
      body.push(`    """${docstring(schema.description)}"""`, "");
    }
    body.push(`    model_config = ConfigDict(${config.join(", ")})`);

    let selfReference = false;
    for (const [wireName, member] of Object.entries(properties ?? {})) {
      const attribute = attributeName(wireName);
      let type = this.typeOf(
        member,
        `${className}${pascalCase(wireName)}`,
        document,
        strict,
      );
      if (type.includes(JSON.stringify(className))) selfReference = true;

      const options: string[] = [];
      let fallback: string | undefined;
      if (!required.has(wireName)) {
        if ("default" in member) {
          fallback = pythonLiteral(member.default);
        } else {
          if (!/(^|\| )None$/.test(type)) type = `${type} | None`;
          fallback = "None";
        }
      }
      if (attribute !== wireName) {
        // Not `alias`: a type checker would then take the wire name for
        // the constructor's parameter, which Python cannot spell.
        options.push(
          `validation_alias=${JSON.stringify(wireName)}`,
          `serialization_alias=${JSON.stringify(wireName)}`,
        );
      }
      if (typeof member.description === "string") {
        options.push(`description=${JSON.stringify(member.description)}`);
      }

      if (options.length === 0) {
        body.push(
          `    ${attribute}: ${type}${fallback ? ` = ${fallback}` : ""}`,
        );
      } else {
        if (fallback !== undefined) options.unshift(`default=${fallback}`);
        body.push(`    ${attribute}: ${type} = Field(${options.join(", ")})`);
      }
    }

    // The classes of its fields were defined while they were rendered, so
    // this one comes after them. One that refers to itself by name
    // resolves that name once it exists.
    this.building.delete(className);
    this.definitions.push({
      name: className,
      lines: [`class ${className}(BaseModel):`, ...body],
      rebuild: selfReference,
    });
    return className;
  }
}

// =============================================================================
// Helpers
// =============================================================================

/** `Annotated[T, Field(...)]` when there is a constraint, else `T`. */
function constrained(type: string, constraints: Record<string, unknown>) {
  const stated = Object.entries(constraints)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${pythonLiteral(value)}`);
  return stated.length === 0
    ? type
    : `Annotated[${type}, Field(${stated.join(", ")})]`;
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

function docstring(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll('"""', '\\"\\"\\"');
}

/**
 * The types of a contract, for generators.
 *
 * A contract carries JSON Schema. A generator for a language with nominal
 * types needs more than a schema says: a name for every object, for every
 * union and for every set of literals; the same object recognised as the
 * same type wherever it occurs; a reference that closes a cycle marked as
 * one. Those decisions do not depend on the target language, so they are
 * taken once, here, and a generator renders the result.
 *
 * `TypeGraph.define()` turns one schema into a `TypeNode` and records the
 * definitions (objects, their other names, and types that refer to
 * themselves) it needs, each after the definitions it uses.
 *
 * @module
 */

import type { JsonSchema } from "../tsgen/extract.ts";

/** A value a literal type can be. */
export type Scalar = string | number | boolean | null;

/** Bounds of a number. */
export interface NumberBounds {
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly exclusiveMaximum?: number;
  readonly multipleOf?: number;
}

/** A type, as a generator sees it. */
export type TypeNode =
  /** Anything: what JSON Schema could not state. */
  | { readonly kind: "any" }
  | { readonly kind: "null" }
  | { readonly kind: "boolean" }
  | {
    readonly kind: "string";
    readonly minLength?: number;
    readonly maxLength?: number;
    /** A regular expression in JavaScript syntax. */
    readonly pattern?: string;
    readonly format?: string;
  }
  | ({ readonly kind: "integer" | "number" } & NumberBounds)
  /** One of a set of values. `name` is free for a generator to use. */
  | {
    readonly kind: "literal";
    readonly name: string;
    readonly values: readonly Scalar[];
  }
  | {
    readonly kind: "array";
    readonly items: TypeNode;
    readonly minItems?: number;
    readonly maxItems?: number;
  }
  | { readonly kind: "tuple"; readonly items: readonly TypeNode[] }
  /** An object with any keys, whose values have one type. */
  | { readonly kind: "map"; readonly values: TypeNode }
  /**
   * One of several types. `null` as a variant is how a nullable type is
   * written. `tag` is the field whose constant tells the object variants
   * apart, when there is one; it is the `discriminator` when every
   * variant is an object, so that the field decides the variant.
   */
  | {
    readonly kind: "union";
    readonly name: string;
    readonly variants: readonly TypeNode[];
    readonly tag?: string;
    readonly discriminator?: string;
  }
  /**
   * A definition, by name. `cyclic` when the definition is the one being
   * defined, or encloses it: a language with value types needs
   * indirection there.
   */
  | { readonly kind: "ref"; readonly name: string; readonly cyclic: boolean };

/** A field of an object. */
export interface FieldNode {
  /** The name on the wire. */
  readonly name: string;
  readonly type: TypeNode;
  /** Whether the field has to be present. */
  readonly required: boolean;
  /** The value a missing field takes, if the schema gives one. */
  readonly default?: { readonly value: unknown };
  readonly description?: string;
}

/** An object type. */
export interface ObjectDefinition {
  readonly kind: "object";
  readonly name: string;
  readonly description?: string;
  /** Whether members the schema does not name are refused. */
  readonly closed: boolean;
  /**
   * Whether the values arrive as text (query and path parameters) and
   * are turned into numbers and booleans, or keep their JSON types.
   */
  readonly text: boolean;
  readonly fields: readonly FieldNode[];
}

/** Another name for a definition: the same object in another place. */
export interface AliasDefinition {
  readonly kind: "alias";
  readonly name: string;
  readonly target: string;
}

/**
 * A type that is not an object and refers to itself: a JSON value, an
 * expression. It cannot be written in place, so it has a name.
 */
export interface NamedDefinition {
  readonly kind: "named";
  readonly name: string;
  readonly type: TypeNode;
}

/** Something a generated module defines. */
export type Definition =
  | ObjectDefinition
  | AliasDefinition
  | NamedDefinition;

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

/** A nullable type as the type it is when it is not null. */
export function withoutNull(
  type: TypeNode,
): { readonly type: TypeNode; readonly nullable: boolean } {
  if (type.kind === "null") return { type, nullable: true };
  if (type.kind !== "union") return { type, nullable: false };
  const rest = type.variants.filter((variant) => variant.kind !== "null");
  if (rest.length === type.variants.length) return { type, nullable: false };
  return {
    type: rest.length === 1 ? rest[0] : { ...type, variants: rest },
    nullable: true,
  };
}

/**
 * Whether a definition is JSON itself: a string, a number, a boolean,
 * null, a list of itself or a map of itself, each without a constraint.
 * Most languages have a type for that already.
 */
export function isJson(definition: Definition): boolean {
  if (definition.kind !== "named" || definition.type.kind !== "union") {
    return false;
  }
  const { variants } = definition.type;
  const self = (node: TypeNode) =>
    node.kind === "ref" && node.name === definition.name;
  // Nothing but the kind: a bound or a pattern makes it another type.
  const bare = (node: TypeNode) => Object.keys(node).length === 1;
  const shapes = variants.map((variant) => {
    switch (variant.kind) {
      case "string":
      case "number":
      case "boolean":
      case "null":
        return bare(variant) ? variant.kind : undefined;
      case "array":
        return Object.keys(variant).length === 2 && self(variant.items)
          ? "array"
          : undefined;
      case "map":
        return self(variant.values) ? "map" : undefined;
      default:
        return undefined;
    }
  });
  return variants.length === 6 &&
    (["string", "number", "boolean", "null", "array", "map"] as const).every(
      (shape) => shapes.includes(shape),
    );
}

type Schema = Readonly<Record<string, unknown>>;

interface Document {
  readonly root: Schema;
  /** The name the root has, once it has one. */
  rootName: string;
  readonly defs: Readonly<Record<string, Schema>>;
}

/** Whether a schema becomes an object definition. */
function isObject(schema: Schema): boolean {
  return schema.type === "object" && schema.properties !== undefined;
}

/** A schema that is not an object, while its type is being worked out. */
interface Open {
  readonly hint: string;
  /** Set when the schema turns out to refer to itself. */
  name?: string;
}

/** The types of a set of schemas, named and shared. */
/** How a `TypeGraph` reads schemas. */
export interface TypeGraphOptions {
  /**
   * Whether the two sides of a schema are one type. What a client sends
   * (the input side) and what JSON carries back (the output side) differ
   * in two ways that a type need not show: on the output side a member
   * with a default is always there, and members the schema does not name
   * are gone. With this set, an object that differs only in those is the
   * same definition on both sides: a member with a default is not
   * required, and no object is closed.
   */
  readonly mergeSides?: boolean;
}

export class TypeGraph {
  /** Every definition, each after the definitions it uses. */
  readonly definitions: Definition[] = [];

  private readonly names = new Set<string>();
  /** Named `$defs`: their content, to tell a reuse from a clash. */
  private readonly shared = new Map<string, string>();
  /** Objects already defined, by content. */
  private readonly known = new Map<string, string>();
  /** The definitions Zod named itself, per document. */
  private readonly unnamed = new Map<Document, Map<string, string>>();
  /** Objects whose fields are being read: a reference to one is a cycle. */
  private readonly building = new Set<string>();
  /** Schemas that are not objects, while their type is worked out. */
  private readonly open = new Map<Schema, Open>();
  /** Types that refer to themselves, by content: their name. */
  private readonly recursive = new Map<string, string>();
  private readonly mergeSides: boolean;

  constructor(options: TypeGraphOptions = {}) {
    this.mergeSides = options.mergeSides ?? false;
  }

  /** What a schema is, apart from where it is written. */
  private content(schema: Schema, document: Document, text: boolean): string {
    return JSON.stringify([
      canonical(schema, document, this.mergeSides),
      text,
    ]);
  }

  /**
   * The type of a schema.
   *
   * @param name Name for the type if it needs one (an object does).
   * @param schema A JSON Schema document.
   * @param text Whether its values arrive as text (query, path).
   */
  define(name: string, schema: JsonSchema, text: boolean): TypeNode {
    const { $defs, $schema: _dialect, ...root } = schema as Schema & {
      $defs?: Record<string, Schema>;
    };
    const document: Document = { root, rootName: name, defs: $defs ?? {} };
    return isObject(root)
      ? this.typeOf(root, name, document, text)
      : this.expand(root, name, document, text);
  }

  /** The definition of that name, following other names to the object. */
  object(name: string): ObjectDefinition | undefined {
    const definition = this.definitions.find((d) => d.name === name);
    if (!definition || definition.kind === "named") return undefined;
    return definition.kind === "alias"
      ? this.object(definition.target)
      : definition;
  }

  /**
   * Whether `null` is a value of the type, also when the type is a name
   * for one that says so.
   */
  nullable(type: TypeNode, seen: ReadonlySet<string> = new Set()): boolean {
    if (type.kind === "null") return true;
    if (type.kind === "union") {
      return type.variants.some((variant) => this.nullable(variant, seen));
    }
    if (type.kind !== "ref" || seen.has(type.name)) return false;
    const definition = this.definitions.find((d) => d.name === type.name);
    return definition?.kind === "named" &&
      this.nullable(definition.type, new Set([...seen, type.name]));
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
    text: boolean,
  ): TypeNode {
    if (typeof schema.$ref === "string") {
      if (schema.$ref === "#") {
        return isObject(document.root)
          ? { kind: "ref", name: document.rootName, cyclic: true }
          : this.expand(document.root, document.rootName, document, text);
      }
      const key = schema.$ref.replace(/^#\/\$defs\//, "");
      const target = document.defs[key];
      if (!target) throw new Error(`Unresolved reference ${schema.$ref}`);
      // A definition Zod named itself (`__schema0`) is named after where
      // it is used.
      return /^__schema\d+$/.test(key)
        ? this.unnamedType(key, target, name, document, text)
        : this.sharedType(key, target, document, text);
    }

    if ("const" in schema) {
      return { kind: "literal", name, values: [schema.const as Scalar] };
    }
    if (Array.isArray(schema.enum)) {
      return { kind: "literal", name, values: schema.enum as Scalar[] };
    }

    const alternatives = (schema.anyOf ?? schema.oneOf) as
      | Schema[]
      | undefined;
    if (Array.isArray(alternatives)) {
      return this.unionOf(alternatives, name, document, text);
    }

    if (Array.isArray(schema.allOf)) {
      const members = schema.allOf as Schema[];
      if (members.length === 1) {
        return this.typeOf(members[0], name, document, text);
      }
      const merged = mergeObjects(members);
      return merged
        ? this.typeOf(merged, name, document, text)
        : { kind: "any" };
    }

    if (Array.isArray(schema.type)) {
      const members = (schema.type as string[]).map((type) => ({
        ...schema,
        type,
      }));
      return this.unionOf(members, name, document, text);
    }

    const number = (key: string) =>
      typeof schema[key] === "number" ? { [key]: schema[key] } : {};
    switch (schema.type) {
      case "null":
        return { kind: "null" };
      case "boolean":
        return { kind: "boolean" };
      case "string":
        return {
          kind: "string",
          ...number("minLength"),
          ...number("maxLength"),
          ...(typeof schema.pattern === "string" &&
            { pattern: schema.pattern }),
          ...(typeof schema.format === "string" && { format: schema.format }),
        };
      case "integer":
      case "number":
        return {
          kind: schema.type,
          ...number("minimum"),
          ...number("maximum"),
          ...number("exclusiveMinimum"),
          ...number("exclusiveMaximum"),
          ...number("multipleOf"),
        };
      case "array": {
        if (Array.isArray(schema.prefixItems)) {
          return {
            kind: "tuple",
            items: (schema.prefixItems as Schema[]).map((member, i) =>
              this.typeOf(member, `${name}Item${i + 1}`, document, text)
            ),
          };
        }
        return {
          kind: "array",
          items: schema.items && typeof schema.items === "object"
            ? this.typeOf(
              schema.items as Schema,
              itemName(name),
              document,
              text,
            )
            : { kind: "any" },
          ...number("minItems"),
          ...number("maxItems"),
        };
      }
      case "object":
        return this.objectOf(schema, name, document, text);
      default:
        return { kind: "any" };
    }
  }

  private unionOf(
    alternatives: readonly Schema[],
    name: string,
    document: Document,
    text: boolean,
  ): TypeNode {
    const { tag, decides } = tagOf(alternatives, document);
    const variants = alternatives.map((member, i) => {
      const value = tag && (resolve(member, document).properties as
        | Record<string, Schema>
        | undefined)?.[tag]?.const;
      const suffix = typeof value === "string" ? pascalCase(value) : `${i + 1}`;
      return this.typeOf(member, `${name}${suffix}`, document, text);
    });
    if (variants.length === 1) return variants[0];
    return {
      kind: "union",
      name,
      variants,
      ...(tag && { tag }),
      ...(tag && decides && { discriminator: tag }),
    };
  }

  private unnamedType(
    key: string,
    schema: Schema,
    hint: string,
    document: Document,
    text: boolean,
  ): TypeNode {
    if (!isObject(schema)) return this.expand(schema, hint, document, text);
    let known = this.unnamed.get(document);
    if (!known) this.unnamed.set(document, known = new Map());
    const existing = known.get(key);
    if (existing !== undefined) {
      return {
        kind: "ref",
        name: existing,
        cyclic: this.building.has(existing),
      };
    }
    // The same object under another name is that object again.
    const same = this.known.get(this.content(schema, document, text));
    if (same !== undefined && !this.building.has(same)) {
      const alias = this.unique(hint);
      known.set(key, alias);
      this.definitions.push({ kind: "alias", name: alias, target: same });
      return { kind: "ref", name: alias, cyclic: false };
    }
    const name = this.unique(hint);
    known.set(key, name);
    return this.objectOf(schema, name, document, text, true);
  }

  private sharedType(
    key: string,
    schema: Schema,
    document: Document,
    text: boolean,
  ): TypeNode {
    if (isObject(schema)) {
      const name = pascalCase(key);
      const content = this.content(schema, document, text);
      const known = this.shared.get(name);
      if (known === content) {
        return { kind: "ref", name, cyclic: this.building.has(name) };
      }
      if (known !== undefined) {
        throw new Error(
          `Two different schemas are named "${key}"; give one another id`,
        );
      }
      this.shared.set(name, content);
      this.names.add(name);
      return this.objectOf(schema, name, document, text, true);
    }
    return this.expand(schema, pascalCase(key), document, text);
  }

  /**
   * The type of a schema that is not an object. Written in place, unless
   * the schema refers to itself: then it is a definition, and the type is
   * a reference to it.
   */
  private expand(
    schema: Schema,
    hint: string,
    document: Document,
    text: boolean,
  ): TypeNode {
    const content = this.content(schema, document, text);
    const known = this.recursive.get(content);
    if (known !== undefined) return { kind: "ref", name: known, cyclic: false };

    const open = this.open.get(schema);
    if (open) {
      // Reached again from inside itself.
      open.name ??= this.unique(open.hint);
      return { kind: "ref", name: open.name, cyclic: true };
    }

    const entry: Open = { hint };
    this.open.set(schema, entry);
    const type = this.typeOf(schema, hint, document, text);
    this.open.delete(schema);
    if (entry.name === undefined) return type;

    this.recursive.set(content, entry.name);
    this.definitions.push({
      kind: "named",
      name: entry.name,
      type: type.kind === "union" ? { ...type, name: entry.name } : type,
    });
    return { kind: "ref", name: entry.name, cyclic: false };
  }

  private objectOf(
    schema: Schema,
    name: string,
    document: Document,
    text: boolean,
    named = false,
  ): TypeNode {
    const properties = schema.properties as
      | Record<string, Schema>
      | undefined;
    const additional = schema.additionalProperties;

    if (!properties || Object.keys(properties).length === 0) {
      if (additional && typeof additional === "object") {
        return {
          kind: "map",
          values: this.typeOf(
            additional as Schema,
            `${name}Value`,
            document,
            text,
          ),
        };
      }
      if (!properties) return { kind: "map", values: { kind: "any" } };
    }

    // The same object under another name is that object again.
    const content = this.content(schema, document, text);
    const isRoot = schema === document.root;
    if (!named) {
      const same = this.known.get(content);
      if (same !== undefined) {
        const alias = this.unique(name);
        this.definitions.push({ kind: "alias", name: alias, target: same });
        return { kind: "ref", name: alias, cyclic: false };
      }
    }

    const typeName = named ? name : this.unique(name);
    // What refers to the root refers to it by the name it got.
    if (isRoot) document.rootName = typeName;
    this.known.set(content, typeName);
    this.building.add(typeName);
    const required = new Set((schema.required as string[] | undefined) ?? []);

    const fields: FieldNode[] = Object.entries(properties ?? {}).map(
      ([wireName, member]) => ({
        name: wireName,
        type: this.typeOf(
          member,
          `${typeName}${pascalCase(wireName)}`,
          document,
          text,
        ),
        // Merged, the sides agree: a default makes a member optional.
        required: required.has(wireName) &&
          !(this.mergeSides && "default" in member),
        ...((this.mergeSides || !required.has(wireName)) &&
          "default" in member && { default: { value: member.default } }),
        ...(typeof member.description === "string" &&
          { description: member.description }),
      }),
    );

    this.building.delete(typeName);
    this.definitions.push({
      kind: "object",
      name: typeName,
      ...(typeof schema.description === "string" &&
        { description: schema.description }),
      closed: additional === false && !this.mergeSides,
      text,
      fields,
    });
    return { kind: "ref", name: typeName, cyclic: false };
  }
}

/**
 * A schema as what it says, whatever document it is in: a reference is
 * replaced by what it refers to, and one that closes a cycle by how far
 * up the cycle begins. Two schemas with the same result describe the
 * same values.
 *
 * @param merge Leave out what differs between the sides of one schema:
 * closed objects, and `required` for a member that has a default.
 */
export function canonical(
  schema: unknown,
  document: {
    readonly root: Readonly<Record<string, unknown>>;
    readonly defs: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  },
  merge = false,
  enclosing: readonly unknown[] = [],
): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item) => canonical(item, document, merge, enclosing));
  }
  if (typeof schema !== "object" || schema === null) return schema;
  const rules = schema as Readonly<Record<string, unknown>>;

  if (typeof rules.$ref === "string") {
    const target = rules.$ref === "#"
      ? document.root
      : document.defs[rules.$ref.replace(/^#\/\$defs\//, "")];
    if (target === undefined) return rules;
    const at = enclosing.lastIndexOf(target);
    return at >= 0
      ? { $cycle: enclosing.length - at }
      : canonical(target, document, merge, enclosing);
  }

  const inner = [...enclosing, schema];
  const properties = (rules.properties ?? {}) as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rules)) {
    if (key === "$schema" || key === "$defs") continue;
    if (merge && key === "additionalProperties" && value === false) continue;
    if (merge && key === "required" && Array.isArray(value)) {
      const always = value.filter((name) => {
        const member = properties[name];
        return !(typeof member === "object" && member !== null &&
          "default" in member);
      });
      if (always.length > 0) result.required = always;
      continue;
    }
    result[key] = canonical(value, document, merge, inner);
  }
  return result;
}

function resolve(schema: Schema, document: Document): Schema {
  if (typeof schema.$ref !== "string") return schema;
  if (schema.$ref === "#") return document.root;
  return document.defs[schema.$ref.replace(/^#\/\$defs\//, "")] ?? schema;
}

/** The name of an item of a list: `Items` holds an `Item`. */
function itemName(list: string): string {
  return list.endsWith("Items") ? list.slice(0, -1) : `${list}Item`;
}

/**
 * The member that decides which alternative of a union a value is, if one
 * does: every alternative is an object that requires it, with a string
 * constant of its own.
 *
 * A generator that turns the union into a tagged type and a checker that
 * picks the alternative to check by that member have to agree on it, so
 * both take it from here.
 */
export function discriminatorOf(
  alternatives: readonly Readonly<Record<string, unknown>>[],
  document: {
    readonly root: Readonly<Record<string, unknown>>;
    readonly defs: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  },
): string | undefined {
  const { tag, decides } = tagOf(alternatives, { ...document, rootName: "" });
  return decides ? tag : undefined;
}

/**
 * The property that tells the object members of a union apart: each of
 * them requires it with a string constant, and no two constants are
 * equal. It `decides` the member when every member is an object.
 */
function tagOf(
  alternatives: readonly Schema[],
  document: Document,
): { tag?: string; decides: boolean } {
  const members = alternatives.map((member) => resolve(member, document));
  const objects = members.filter((member) => member.type === "object");
  const decides = objects.length === members.length && members.length > 1;
  if (objects.length === 0) return { decides: false };

  const first = (objects[0].properties ?? {}) as Record<string, Schema>;
  for (const key of Object.keys(first)) {
    const values = objects.map((member) => {
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
      return { tag: key, decides };
    }
  }
  return { decides: false };
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

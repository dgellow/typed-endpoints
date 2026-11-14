/**
 * Zod schema → TypeScript type text.
 *
 * Walks the schema definition, so it needs no TypeScript compiler. Written
 * for Zod v4 (`schema._zod.def`).
 *
 * @module
 */

import type { ZodType } from "zod";
import {
  isOptionalField,
  isZodSchema,
  type ZodDef as Def,
  zodDef,
  zodInternals,
  zodType,
} from "../core/zod_internals.ts";
import {
  type DependentDescriptor,
  dependentDescriptor,
} from "../core/dependent_types.ts";

// =============================================================================
// Options
// =============================================================================

export interface TypeStringOptions {
  /**
   * Which side of the schema to describe. Default: `"output"`.
   *
   * - `"output"`: what parsing produces (`z.output`).
   * - `"input"`: what a caller provides (`z.input`). Fields with a default
   *   are optional, a pipe is described by its input side. One deliberate
   *   difference from `z.input`: a coerced schema (`z.coerce.number()`) is
   *   described by its target type, not `unknown`, because a client
   *   serialises the value and the server coerces it back.
   */
  readonly io?: "input" | "output";
  /**
   * Describe the value as it exists after a JSON round trip. Default: off.
   *
   * With `"json"`, an output `Date` is a `string`, and schemas that JSON
   * cannot carry (bigint, symbol, map, set, function, promise) are rejected
   * with an error that names the path.
   */
  readonly wire?: "json";
  /**
   * Collects named declarations. Required for recursive schemas, which
   * cannot be written as one inline type.
   */
  readonly declarations?: TypeDeclarations;
  /**
   * How to describe a schema whose type depends on the request
   * (`projection()`, `expansion()`). Default: `"fallback"`.
   *
   * - `"fallback"`: the type that holds for every request.
   * - `"families"`: `Dependent<Family, Fallback>`, to be applied to the
   *   request with `Resolve`. The helper types used are recorded in
   *   `declarations.helpers`; the output has to import them.
   */
  readonly dependent?: "fallback" | "families";
}

/**
 * Named type declarations produced while converting schemas.
 *
 * Share one instance across all conversions that end up in the same file.
 */
export class TypeDeclarations {
  readonly #names = new Map<unknown, Map<string, string>>();
  readonly #texts = new Map<string, string>();
  readonly #used = new Set<string>();
  /**
   * Helper types the converted text refers to (`Dependent`, `Projection`,
   * ...). A file that contains the text imports them from the client entry
   * point of this package.
   */
  readonly helpers: Set<string> = new Set<string>();

  /** Name already given to this schema in this mode, if any. */
  nameOf(schema: unknown, mode: string): string | undefined {
    return this.#names.get(schema)?.get(mode);
  }

  /** Give this schema a name in this mode. */
  assign(schema: unknown, mode: string, preferred: string): string {
    let name = preferred;
    for (let n = 2; this.#used.has(name); n++) name = `${preferred}${n}`;
    this.#used.add(name);

    let byMode = this.#names.get(schema);
    if (!byMode) this.#names.set(schema, byMode = new Map());
    byMode.set(mode, name);
    return name;
  }

  /** Record the type text of a named declaration. */
  define(name: string, text: string): void {
    this.#texts.set(name, text);
  }

  /** `[name, type text]` in definition order. */
  entries(): [string, string][] {
    return [...this.#texts];
  }

  get size(): number {
    return this.#texts.size;
  }
}

// =============================================================================
// Internals
// =============================================================================

/** Precedence of a type expression, lowest binds loosest. */
const Prec = { Function: 0, Union: 1, Intersection: 2, Atom: 3 } as const;
type Prec = (typeof Prec)[keyof typeof Prec];

interface Node {
  readonly text: string;
  readonly prec: Prec;
  /** The members of a union node, each already parenthesised as needed. */
  readonly members?: readonly string[];
}

interface State {
  readonly io: "input" | "output";
  readonly wire: "json" | undefined;
  readonly mode: string;
  /** Describe dependent places as families, not by their fallback. */
  readonly families: boolean;
  readonly declarations: TypeDeclarations;
  /** Object and lazy schemas currently being converted (cycle detection). */
  readonly active: Set<unknown>;
  readonly path: string[];
}

function getType(schema: unknown): string {
  return zodType(schema) ?? "unknown";
}

const atom = (text: string): Node => ({ text, prec: Prec.Atom });

/** Text of `node` where an expression of at least `min` precedence is needed. */
function wrap(node: Node, min: Prec): string {
  return node.prec < min ? `(${node.text})` : node.text;
}

function literalText(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") return `${value}n`;
  return String(value);
}

/** Whether `name` can be written as a bare identifier or property name. */
export function isIdentifier(name: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(name);
}

/** `key` as it is written in an object type: quoted unless an identifier. */
export function propertyKey(key: string): string {
  return isIdentifier(key) ? key : JSON.stringify(key);
}

function templateText(text: string): string {
  return text.replace(/[\\`]/g, "\\$&").replace(/\$\{/g, "\\${");
}

function unionOf(nodes: Node[]): Node {
  // Flattened and without repeats: `.optional()` on an optional schema
  // would otherwise read `T | undefined | undefined`.
  const members = [
    ...new Set(
      nodes.flatMap((n) => n.members ?? [wrap(n, Prec.Union)]),
    ),
  ];
  if (members.length === 1) {
    return nodes.find((n) =>
      !n.members && wrap(n, Prec.Union) === members[0]
    ) ??
      atom(members[0]);
  }
  return { text: members.join(" | "), prec: Prec.Union, members };
}

function description(schema: unknown): string | undefined {
  const value = (schema as { description?: unknown })?.description;
  return typeof value === "string" && value !== "" ? value : undefined;
}

function preferredName(schema: unknown, state: State): string {
  let id: unknown;
  try {
    id = (schema as { meta?: () => { id?: unknown } | undefined }).meta?.()?.id;
  } catch {
    // Not a schema with a registry; fall through to the generated name.
  }
  const base = typeof id === "string" && isIdentifier(id) ? id : "Recursive";
  return state.io === "input" ? `${base}Input` : base;
}

function notJson(what: string, state: State): never {
  const where = state.path.length > 0 ? state.path.join(".") : "(root)";
  throw new Error(
    `Cannot describe ${what} at ${where} as JSON: JSON has no representation for it`,
  );
}

// =============================================================================
// Conversion
// =============================================================================

function convert(schema: unknown, state: State): Node {
  if (state.families) {
    const dependent = dependentDescriptor(schema);
    if (dependent) return convertDependent(schema, dependent, state);
  }
  return convertPlain(schema, state);
}

/** `Dependent<Family<Base, "param", ...>, Fallback>` for a dependent place. */
function convertDependent(
  schema: unknown,
  dependent: DependentDescriptor,
  state: State,
): Node {
  const base = convert(dependent.base, state).text;
  const param = JSON.stringify(dependent.param);
  const fallback = convertPlain(schema, state).text;

  let family: string;
  if (dependent.kind === "projection") {
    state.declarations.helpers.add("Projection");
    family = `Projection<${base}, ${param}>`;
  } else if (dependent.kind === "selection") {
    state.declarations.helpers.add("Selection");
    family = `Selection<${base}, ${param}>`;
  } else {
    state.declarations.helpers.add("Expansion");
    const relations = Object.entries(dependent.relations ?? {}).map(
      ([name, relation]) => {
        state.path.push(name);
        const text = convert(relation, state).text;
        state.path.pop();
        return `${propertyKey(name)}: ${text};`;
      },
    );
    family = `Expansion<${base}, ${param}, { ${relations.join(" ")} }>`;
  }

  state.declarations.helpers.add("Dependent");
  return atom(`Dependent<${family}, ${fallback}>`);
}

function convertPlain(schema: unknown, state: State): Node {
  const type = getType(schema);
  // Objects (getter recursion) and lazy schemas are where a cycle closes.
  if (type !== "object" && type !== "lazy") return convertInner(schema, state);

  const known = state.declarations.nameOf(schema, state.mode);
  if (known) return atom(known);

  if (state.active.has(schema)) {
    return atom(
      state.declarations.assign(
        schema,
        state.mode,
        preferredName(schema, state),
      ),
    );
  }

  state.active.add(schema);
  const node = convertInner(schema, state);
  state.active.delete(schema);

  const name = state.declarations.nameOf(schema, state.mode);
  if (!name) return node;
  state.declarations.define(name, node.text);
  return atom(name);
}

function convertObject(def: Def, state: State): Node {
  const shape = def.shape as Record<string, unknown>;
  const props = Object.keys(shape).map((key) => {
    state.path.push(key);
    const value = shape[key];
    const optional = isOptionalField(value, state.io) ? "?" : "";
    const doc = description(value);
    const docText = doc ? `/** ${doc.replace(/\*\//g, "*\\/")} */ ` : "";
    const text = `${docText}${propertyKey(key)}${optional}: ${
      convert(value, state).text
    }`;
    state.path.pop();
    return text;
  });

  // catchall: absent or never → closed; unknown/any → open in place;
  // anything else → a separate index signature, as z.infer does.
  const catchallType = def.catchall ? getType(def.catchall) : "never";
  let indexed: string | undefined;
  if (catchallType === "unknown" || catchallType === "any") {
    props.push(`[key: string]: ${catchallType}`);
  } else if (catchallType !== "never") {
    state.path.push("[key]");
    indexed = `{ [key: string]: ${convert(def.catchall, state).text}; }`;
    state.path.pop();
  }

  const own = props.length === 0 ? "{}" : `{ ${props.join("; ")}; }`;
  if (!indexed) return atom(own);
  return { text: `${own} & ${indexed}`, prec: Prec.Intersection };
}

function convertTuple(def: Def, state: State): Node {
  const items = def.items as unknown[];
  // Trailing optional elements are optional tuple members.
  let firstOptional = items.length;
  while (
    firstOptional > 0 && isOptionalField(items[firstOptional - 1], state.io)
  ) {
    firstOptional--;
  }

  const parts = items.map((item, i) => {
    state.path.push(String(i));
    const node = convert(item, state);
    state.path.pop();
    return i >= firstOptional ? `${wrap(node, Prec.Atom)}?` : node.text;
  });
  if (def.rest) {
    parts.push(`...${wrap(convert(def.rest, state), Prec.Atom)}[]`);
  }
  return atom(`[${parts.join(", ")}]`);
}

function convertRecord(def: Def, state: State): Node {
  const key = def.keyType ? convert(def.keyType, state).text : "string";
  const value = convert(def.valueType, state).text;
  const record = `Record<${key}, ${value}>`;

  // z.partialRecord(): newer Zod 4 releases flag the record as partial;
  // older ones keep an enum or literal key type but drop its list of
  // required keys.
  const keyType = getType(def.keyType);
  const enumerable = keyType === "enum" || keyType === "literal";
  const partial = def.partial === true ||
    (enumerable && zodInternals(def.keyType).values === undefined);
  return atom(partial ? `Partial<${record}>` : record);
}

function convertReadonly(def: Def, state: State): Node {
  const inner = convert(def.innerType, state);
  switch (getType(def.innerType)) {
    case "array":
    case "tuple":
      return { text: `readonly ${inner.text}`, prec: Prec.Union };
    case "map":
      return atom(inner.text.replace(/^Map</, "ReadonlyMap<"));
    case "set":
      return atom(inner.text.replace(/^Set</, "ReadonlySet<"));
    case "object":
    case "record":
      return atom(`Readonly<${inner.text}>`);
    default:
      return inner;
  }
}

function convertTemplateLiteral(def: Def, state: State): Node {
  const parts = (def.parts as unknown[]).map((part) => {
    if (isZodSchema(part)) return `\${${convert(part, state).text}}`;
    return templateText(String(part));
  });
  return atom(`\`${parts.join("")}\``);
}

function convertInner(schema: unknown, state: State): Node {
  const def = zodDef(schema);
  const json = state.wire === "json";

  switch (getType(schema)) {
    // Primitives
    case "string":
      return atom("string");
    case "number":
    case "int":
    case "nan":
      return atom("number");
    case "boolean":
    case "success":
      return atom("boolean");
    case "bigint":
      return json ? notJson("z.bigint()", state) : atom("bigint");
    case "symbol":
      return json ? notJson("z.symbol()", state) : atom("symbol");
    case "date":
      // JSON.stringify writes a Date as an ISO string; nothing revives it.
      return atom(json && state.io === "output" ? "string" : "Date");
    case "file":
      return atom("File");

    // Special types
    case "any":
      return atom("any");
    case "unknown":
      return atom("unknown");
    case "never":
      return atom("never");
    case "void":
      return atom("void");
    case "null":
      return atom("null");
    case "undefined":
      return atom("undefined");

    case "literal":
      return unionOf(
        (def.values as unknown[]).map((v) => {
          if (json && typeof v === "bigint") notJson("a bigint literal", state);
          return atom(literalText(v));
        }),
      );

    case "enum":
      return unionOf(
        Object.values(def.entries as Record<string, unknown>)
          .map((v) => atom(literalText(v))),
      );

    case "template_literal":
      return convertTemplateLiteral(def, state);

    case "array":
      return atom(`${wrap(convert(def.element, state), Prec.Atom)}[]`);

    case "object":
      return convertObject(def, state);

    case "tuple":
      return convertTuple(def, state);

    case "record":
      return convertRecord(def, state);

    case "map": {
      if (json) notJson("z.map()", state);
      const key = convert(def.keyType, state).text;
      return atom(`Map<${key}, ${convert(def.valueType, state).text}>`);
    }

    case "set":
      if (json) notJson("z.set()", state);
      return atom(`Set<${convert(def.valueType, state).text}>`);

    case "promise":
      if (json) notJson("z.promise()", state);
      return atom(`Promise<${convert(def.innerType, state).text}>`);

    case "function": {
      if (json) notJson("z.function()", state);
      const input = def.input ? convert(def.input, state).text : "[]";
      const output = def.output ? convert(def.output, state).text : "void";
      return { text: `(...args: ${input}) => ${output}`, prec: Prec.Function };
    }

    case "optional":
      return unionOf([convert(def.innerType, state), atom("undefined")]);

    case "nullable":
      return unionOf([convert(def.innerType, state), atom("null")]);

    case "union":
      return unionOf((def.options as unknown[]).map((o) => convert(o, state)));

    case "intersection": {
      const left = wrap(convert(def.left, state), Prec.Intersection);
      const right = wrap(convert(def.right, state), Prec.Intersection);
      return { text: `${left} & ${right}`, prec: Prec.Intersection };
    }

    case "lazy":
      return convert((def.getter as () => unknown)(), state);

    case "default":
    case "prefault": {
      const inner = convert(def.innerType, state);
      // As an object key the "?" marks it; standalone it accepts undefined.
      return state.io === "input" ? unionOf([inner, atom("undefined")]) : inner;
    }

    case "nonoptional": {
      const inner = def.innerType;
      return convert(
        getType(inner) === "optional" ? zodDef(inner).innerType : inner,
        state,
      );
    }

    case "catch":
      return convert(def.innerType, state);

    case "readonly":
      return convertReadonly(def, state);

    case "pipe":
      return convert(state.io === "input" ? def.in : def.out, state);

    // The result of a transform or a custom check is not in the schema.
    case "transform":
    case "custom":
    default:
      return atom("unknown");
  }
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Convert a Zod schema to a TypeScript type string.
 *
 * A recursive schema becomes a named declaration in `options.declarations`
 * and the returned text is that name. Without `declarations`, a recursive
 * schema is an error.
 */
export function zodToTypeString(
  schema: ZodType,
  options: TypeStringOptions = {},
): string {
  const io = options.io ?? "output";
  const declarations = options.declarations ?? new TypeDeclarations();
  const families = options.dependent === "families";
  const state: State = {
    io,
    wire: options.wire,
    mode: `${io}:${options.wire ?? ""}${families ? ":families" : ""}`,
    families,
    declarations,
    active: new Set(),
    path: [],
  };

  const { text } = convert(schema, state);

  if (!options.declarations && declarations.size > 0) {
    const names = declarations.entries().map(([name]) => name).join(", ");
    throw new Error(
      `The schema is recursive (${names}). Pass \`declarations\` to zodToTypeString to collect the named types it needs.`,
    );
  }

  return text;
}

/**
 * Schema introspection for protocol validation.
 *
 * Answers "does this schema have a value at this path?" without running the
 * schema. Reads Zod v4 definitions (`schema._zod.def`).
 *
 * @module
 */

import { unwrapSchema, zodDef, zodType } from "../core/zod_internals.ts";

/**
 * - `"found"`: the schema describes a value at the path
 * - `"missing"`: the schema rules the path out
 * - `"unknown"`: the schema does not say (any, unknown, record, catchall,
 *   transform output)
 */
export type PathLookup = "found" | "missing" | "unknown";

function combine(results: PathLookup[]): PathLookup {
  if (results.includes("found")) return "found";
  if (results.includes("unknown")) return "unknown";
  return "missing";
}

/**
 * Look up a dot-notation path in a schema.
 *
 * `side` is `"output"` for a response (the session stores parsed values) and
 * `"input"` for a request.
 */
export function lookupPath(
  schema: unknown,
  path: readonly string[],
  side: "input" | "output",
): PathLookup {
  const current = unwrapSchema(schema, side);
  if (path.length === 0) return "found";

  const def = zodDef(current);
  const [head, ...rest] = path;

  switch (def.type) {
    case "object": {
      const shape = def.shape as Record<string, unknown>;
      if (Object.hasOwn(shape, head)) {
        return lookupPath(shape[head], rest, side);
      }
      // Keys outside the shape are allowed when there is a catchall.
      const catchall = def.catchall ? zodType(def.catchall) : "never";
      return catchall === "never" ? "missing" : "unknown";
    }
    case "union":
      return combine(
        (def.options as unknown[]).map((o) => lookupPath(o, path, side)),
      );
    case "intersection":
      return combine([
        lookupPath(def.left, path, side),
        lookupPath(def.right, path, side),
      ]);
    case "array":
      return /^\d+$/.test(head)
        ? lookupPath(def.element, rest, side)
        : "missing";
    case "tuple": {
      const items = def.items as unknown[];
      const index = /^\d+$/.test(head) ? Number(head) : -1;
      if (index >= 0 && index < items.length) {
        return lookupPath(items[index], rest, side);
      }
      return index >= 0 && def.rest
        ? lookupPath(def.rest, rest, side)
        : "missing";
    }
    case "record":
    case "map":
    case "any":
    case "unknown":
    case "custom":
    case "transform":
    case undefined:
      return "unknown";
    default:
      // A primitive has nothing below it.
      return "missing";
  }
}

/**
 * The schemas a schema has at a dot-notation path: one per union member
 * that describes a value there. Empty when none does or the schema does
 * not say.
 */
export function schemasAtPath(
  schema: unknown,
  path: readonly string[],
  side: "input" | "output",
): unknown[] {
  const current = unwrapSchema(schema, side);
  if (path.length === 0) return [current];

  const def = zodDef(current);
  const [head, ...rest] = path;

  switch (def.type) {
    case "object": {
      const shape = def.shape as Record<string, unknown>;
      return Object.hasOwn(shape, head)
        ? schemasAtPath(shape[head], rest, side)
        : [];
    }
    case "union":
      return (def.options as unknown[]).flatMap((option) =>
        schemasAtPath(option, path, side)
      );
    case "intersection":
      return [
        ...schemasAtPath(def.left, path, side),
        ...schemasAtPath(def.right, path, side),
      ];
    case "array":
      return /^\d+$/.test(head) ? schemasAtPath(def.element, rest, side) : [];
    case "tuple": {
      const items = def.items as unknown[];
      const index = /^\d+$/.test(head) ? Number(head) : -1;
      if (index >= 0 && index < items.length) {
        return schemasAtPath(items[index], rest, side);
      }
      return index >= 0 && def.rest ? schemasAtPath(def.rest, rest, side) : [];
    }
    default:
      return [];
  }
}

/** The kinds of value a schema can be told to hold without running it. */
export type PrimitiveKind = "string" | "number" | "boolean" | "bigint" | "date";

/**
 * The primitive kind of the values a schema accepts, when it has exactly
 * one: `z.string()`, a string format, an enum of strings and a string
 * literal are all `"string"`. `undefined` for anything else (objects,
 * unions of several kinds, schemas that do not say).
 */
export function primitiveKind(
  schema: unknown,
  side: "input" | "output",
): PrimitiveKind | undefined {
  const current = unwrapSchema(schema, side);
  const def = zodDef(current);

  const kindOfValues = (values: unknown[]): PrimitiveKind | undefined => {
    const kinds = new Set(values.map((value) => typeof value));
    const [kind] = kinds;
    return kinds.size === 1 &&
        (kind === "string" || kind === "number" || kind === "boolean" ||
          kind === "bigint")
      ? kind
      : undefined;
  };

  switch (def.type) {
    case "string":
    case "template_literal":
      return "string";
    case "number":
    case "int":
      return "number";
    case "boolean":
      return "boolean";
    case "bigint":
      return "bigint";
    case "date":
      return "date";
    case "literal":
      return kindOfValues(def.values as unknown[]);
    case "enum":
      return kindOfValues(Object.values(def.entries as object));
    default:
      return undefined;
  }
}

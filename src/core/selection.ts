/**
 * Selections written as one string: `?select=id,author(name,posts(title))`.
 *
 * `selection()` is the response-side builder, next to `projection()` and
 * `expansion()`: the schema it returns holds for every request, and it
 * carries the rule. The generated client computes the response type of a
 * call from the select string the call passes (`selection_types.ts`), and
 * rejects a string that names a property the object does not have.
 *
 * @example
 * ```ts
 * const Post = z.object({
 *   id: z.string(),
 *   title: z.string(),
 *   author: z.object({ id: z.string(), name: z.string() }),
 * });
 *
 * GET: endpoint({
 *   query: z.object({ select: selectOf(Post) }),
 *   response: z.array(selection(Post, "select")),
 *   // The complete objects: the library cuts them down to the request.
 *   handler: () => posts,
 * })
 *
 * // Generated client:
 * const posts = await client.posts.list({
 *   query: { select: "id,author(name)" },
 * });
 * posts[0].author.name; // string
 * posts[0].title;       // compile error: not selected
 * client.posts.list({ query: { select: "id,author(age)" } });
 * // compile error: "author.age" is not a field
 * ```
 *
 * @module
 */

import { z } from "zod";

import { DEPENDENT, type Dependent } from "./dependent_types.ts";
import type { PartialDeep, Selection, SelectNode } from "./selection_types.ts";
import { unwrapSchema, zodDef, zodType } from "./zod_internals.ts";

// =============================================================================
// Syntax
// =============================================================================

/** A select string that cannot be read. */
export class SelectSyntaxError extends Error {
  /**
   * Create the error.
   *
   * @param message What is wrong.
   * @param position Index in the string where it was noticed.
   */
  constructor(
    message: string,
    /** Index in the string where it was noticed. */
    readonly position: number,
  ) {
    super(`${message} (at position ${position})`);
    this.name = "SelectSyntaxError";
  }
}

/**
 * Parse a select string into its syntax tree.
 *
 * Grammar: `select = item ("," item)*`, `item = name | name "(" select ")"`.
 * Spaces around items are ignored. `*` is a name: every property.
 *
 * @param text The select string.
 * @throws SelectSyntaxError
 */
export function parseSelect(text: string): SelectNode[] {
  let position = 0;

  const skipSpaces = () => {
    while (text[position] === " ") position++;
  };

  const items = (): SelectNode[] => {
    const nodes: SelectNode[] = [];
    while (true) {
      nodes.push(item());
      skipSpaces();
      if (text[position] !== ",") return nodes;
      position++;
    }
  };

  const item = (): SelectNode => {
    skipSpaces();
    const start = position;
    while (position < text.length && !",() ".includes(text[position])) {
      position++;
    }
    const name = text.slice(start, position);
    if (name === "") {
      throw new SelectSyntaxError("expected a field name", position);
    }
    skipSpaces();
    if (text[position] !== "(") return { name, children: undefined };

    position++;
    const children = items();
    if (text[position] !== ")") {
      throw new SelectSyntaxError(`missing ")" after "${name}("`, position);
    }
    position++;
    return { name, children };
  };

  const nodes = items();
  if (position < text.length) {
    throw new SelectSyntaxError(
      `unexpected "${text.slice(position)}"`,
      position,
    );
  }
  return nodes;
}

// =============================================================================
// Against a schema
// =============================================================================

/** The object schema a selection inside `schema` applies to, if any. */
function selectable(schema: unknown): unknown {
  let current = unwrapSchema(schema, "output");
  while (zodType(current) === "array") {
    current = unwrapSchema(zodDef(current).element, "output");
  }
  return zodType(current) === "object" ? current : undefined;
}

/**
 * What is wrong with a selection of the object `schema` describes: one
 * message per property that does not exist or has nothing to select in.
 * Empty when the selection fits.
 *
 * @param schema Schema of the complete object.
 * @param nodes The selection.
 */
export function selectionIssues(
  schema: unknown,
  nodes: readonly SelectNode[],
  path = "",
): string[] {
  const object = selectable(schema);
  if (object === undefined) return [];
  const shape = zodDef(object).shape as Record<string, unknown>;

  const issues: string[] = [];
  for (const node of nodes) {
    if (node.name === "*") continue;
    const field = shape[node.name];
    if (field === undefined) {
      issues.push(`"${path}${node.name}" is not a field`);
    } else if (node.children) {
      if (selectable(field) === undefined) {
        issues.push(`"${path}${node.name}" has no fields to select`);
      } else {
        issues.push(
          ...selectionIssues(field, node.children, `${path}${node.name}.`),
        );
      }
    }
  }
  return issues;
}

/**
 * A value cut down to a selection: the listed properties, and inside
 * those with a selection of their own, the same again. Arrays are cut
 * down element by element; anything that is not an object stays.
 *
 * @param value The complete value.
 * @param nodes The selection.
 */
export function applySelection(
  value: unknown,
  nodes: readonly SelectNode[],
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => applySelection(item, nodes));
  }
  if (value === null || typeof value !== "object") return value;

  const object = value as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  if (nodes.some((node) => node.name === "*")) Object.assign(picked, object);
  for (const node of nodes) {
    if (node.name === "*" || !(node.name in object)) continue;
    picked[node.name] = node.children
      ? applySelection(object[node.name], node.children)
      : object[node.name];
  }
  return picked;
}

// =============================================================================
// Builders
// =============================================================================

/** `schema` with every object property optional, at every depth. */
function partialDeep(schema: unknown): z.ZodType {
  const def = zodDef(schema);
  switch (def.type) {
    case "object": {
      const shape = Object.fromEntries(
        Object.entries(def.shape as Record<string, unknown>).map((
          [key, field],
        ) => [key, partialDeep(field).optional()]),
      );
      return z.object(shape);
    }
    case "array":
      return z.array(partialDeep(def.element));
    case "optional":
      return partialDeep(def.innerType).optional();
    case "nullable":
      return partialDeep(def.innerType).nullable();
    default:
      return schema as z.ZodType;
  }
}

/** Schema returned by `selection()`. */
export type SelectionSchema<
  TSchema extends z.ZodObject,
  TParam extends string,
> = z.ZodType<
  Dependent<
    Selection<z.output<TSchema>, TParam>,
    PartialDeep<z.output<TSchema>>
  >,
  PartialDeep<z.input<TSchema>>
>;

/**
 * A response object that has the properties the request's select string
 * names, nested ones included.
 *
 * The schema is `schema` with every property optional at every depth: any
 * selection is valid. The generated client types a call by its arguments:
 * with `{ query: { [param]: "id,author(name)" } }` the type is
 * `{ id: string; author: { name: string } }`, without the parameter it is
 * the complete object.
 *
 * A handler returns the complete object; the library applies the
 * selection of the request to it.
 *
 * @param schema Schema of the complete object.
 * @param param Name of the query parameter that carries the select string.
 */
export function selection<
  TSchema extends z.ZodObject,
  const TParam extends string,
>(schema: TSchema, param: TParam): SelectionSchema<TSchema, TParam> {
  const partial = partialDeep(schema);
  Object.defineProperty(partial, DEPENDENT, {
    value: { kind: "selection", param, base: schema },
  });
  return partial as unknown as SelectionSchema<TSchema, TParam>;
}

/**
 * Schema of the query parameter for `selection()`: an optional select
 * string that parses and names only properties `schema` has. A request
 * with any other string fails validation, with the reason.
 *
 * @param schema Schema of the complete object.
 */
export function selectOf(
  schema: z.ZodObject,
): z.ZodOptional<z.ZodString> {
  return z.string().superRefine((text, ctx) => {
    let nodes: SelectNode[];
    try {
      nodes = parseSelect(text);
    } catch (error) {
      if (!(error instanceof SelectSyntaxError)) throw error;
      ctx.addIssue({ code: "custom", message: error.message });
      return;
    }
    for (const message of selectionIssues(schema, nodes)) {
      ctx.addIssue({ code: "custom", message });
    }
  }).optional();
}

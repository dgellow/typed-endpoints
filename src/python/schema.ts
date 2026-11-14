/**
 * A schema of a contract as Python data.
 *
 * The generated FastAPI module checks a request against the contract's
 * JSON Schema, which it carries as a dict: the schema as the contract has
 * it, so the module can also show it where FastAPI describes the API.
 * Three things are done to it:
 *
 * - `$schema` is left out: it names the dialect, for a reader of a
 *   document
 * - a union whose alternatives are told apart by one member gets that
 *   member's name as `discriminator`, the keyword OpenAPI has for it. The
 *   type graph finds the member (`discriminatorOf()`), so the checker and
 *   the types of every language agree on it
 * - a long pattern is the name of a constant, which the models share
 *
 * @module
 */

import type { JsonSchema } from "../contract/index.ts";
import { discriminatorOf } from "../contract/types.ts";
import { pythonLiteral, type PythonModels } from "./models.ts";

type Json = Readonly<Record<string, unknown>>;

/** Keywords whose value is a schema. */
const SCHEMA = new Set([
  "items",
  "additionalProperties",
  "propertyNames",
  "contains",
  "not",
]);

/** Keywords whose value is a list of schemas. */
const SCHEMAS = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);

/** Keywords whose value is schemas by name. */
const NAMED = new Set(["properties", "$defs", "patternProperties"]);

/**
 * A schema as a Python dict display, on one line: `format.ts` breaks it.
 *
 * @param models Where the constant of a long pattern is defined.
 */
export function schemaLiteral(
  schema: JsonSchema,
  models: PythonModels,
): string {
  const root = schema as Json;
  const document = {
    root,
    defs: (root.$defs ?? {}) as Readonly<Record<string, Json>>,
  };

  const render = (value: unknown): string => {
    // `true` and `false` are schemas too.
    if (typeof value !== "object" || value === null) {
      return pythonLiteral(value);
    }
    const rules = value as Json;
    const entries: [string, string][] = [];
    for (const [key, member] of Object.entries(rules)) {
      if (key === "$schema") continue;
      if (key === "pattern" && typeof member === "string") {
        entries.push([key, models.patternText(member, rules.format)]);
      } else if (NAMED.has(key)) {
        const named = Object.entries(member as Json).map(([name, each]) =>
          `${pythonLiteral(name)}: ${render(each)}`
        );
        entries.push([key, `{${named.join(", ")}}`]);
      } else if (SCHEMAS.has(key) && Array.isArray(member)) {
        entries.push([key, `[${member.map(render).join(", ")}]`]);
      } else if (SCHEMA.has(key)) {
        entries.push([key, render(member)]);
      } else {
        entries.push([key, pythonLiteral(member)]);
      }
    }
    const alternatives = rules.anyOf ?? rules.oneOf;
    if (Array.isArray(alternatives) && !("discriminator" in rules)) {
      const tag = discriminatorOf(alternatives as Json[], document);
      if (tag !== undefined) {
        entries.push([
          "discriminator",
          `{"propertyName": ${pythonLiteral(tag)}}`,
        ]);
      }
    }
    return `{${
      entries.map(([key, text]) => `${pythonLiteral(key)}: ${text}`).join(", ")
    }}`;
  };

  return render(root);
}

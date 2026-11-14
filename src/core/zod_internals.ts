/**
 * Readers for Zod v4 schema internals (`schema._zod`).
 *
 * Every place that inspects a schema instead of running it goes through this
 * module, so a change in Zod's internal layout is fixed in one file.
 *
 * Imported by URL into a subprocess by the type generator, so this module
 * must not import anything.
 *
 * @module
 */

/** A schema definition: `schema._zod.def`. */
export type ZodDef = Record<string, unknown>;

/** Whether the value is a Zod v4 schema. */
export function isZodSchema(value: unknown): boolean {
  return typeof value === "object" && value !== null && "_zod" in value;
}

/** `schema._zod`, or an empty object for a value that is not a Zod schema. */
export function zodInternals(schema: unknown): Record<string, unknown> {
  const zod = (schema as { _zod?: Record<string, unknown> } | null | undefined)
    ?._zod;
  return zod ?? {};
}

/** `schema._zod.def`, or an empty object for a value that is not a schema. */
export function zodDef(schema: unknown): ZodDef {
  return (zodInternals(schema).def ?? {}) as ZodDef;
}

/** The schema type tag (`"object"`, `"string"`, ...), if there is one. */
export function zodType(schema: unknown): string | undefined {
  const type = zodDef(schema).type;
  return typeof type === "string" ? type : undefined;
}

/** Wrapper schema types that carry the described type in `innerType`. */
const WRAPPERS: ReadonlySet<string> = new Set([
  "optional",
  "nullable",
  "default",
  "prefault",
  "catch",
  "readonly",
  "nonoptional",
]);

/**
 * The schema that describes the value itself: wrappers, pipes and lazy
 * getters removed. `side` picks which end of a pipe describes the value.
 */
export function unwrapSchema(
  schema: unknown,
  side: "input" | "output",
): unknown {
  let current = schema;
  while (true) {
    const def = zodDef(current);
    if (WRAPPERS.has(def.type as string)) current = def.innerType;
    else if (def.type === "pipe") current = side === "input" ? def.in : def.out;
    else if (def.type === "lazy") current = (def.getter as () => unknown)();
    else return current;
  }
}

/**
 * Whether an object key with this schema may be left out on the given side.
 *
 * On the input side a default makes the key optional; on the output side it
 * does not.
 */
export function isOptionalField(
  schema: unknown,
  side: "input" | "output",
): boolean {
  const zod = zodInternals(schema);
  const flag = side === "input" ? zod.optin : zod.optout;
  // Zod flags a default on the input side as "optional" or, in newer
  // releases, "defaulted".
  if (flag !== undefined) return flag === "optional" || flag === "defaulted";
  // Fallback for schemas that do not carry the flag.
  const type = zodType(schema);
  if (type === "optional") return true;
  return side === "input" && (type === "default" || type === "prefault");
}

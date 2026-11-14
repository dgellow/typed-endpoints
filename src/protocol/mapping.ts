/**
 * Declarative Field Mappings
 *
 * Provides a static, inspectable alternative to dependent step request functions
 * for the common case of literal field forwarding.
 *
 * Instead of:
 *   request: (prev) => z.object({ code: z.literal(prev.code) })
 *
 * Write:
 *   requestMapping: { code: fromStep("authorize", "code") }
 *   requestSchema: z.object({ code: z.string() })
 *
 * The mapping is plain data — tooling can inspect it without executing code.
 * At runtime, mapped fields are enforced as z.literal() just like dependentStep.
 *
 * @module
 */

import { z } from "zod";

// =============================================================================
// Field Mapping Marker
// =============================================================================

/**
 * A declarative marker indicating a field's value comes from a previous step's response.
 *
 * Plain data object — no Zod, no runtime behavior. Exists for static inspection.
 */
export interface FieldMapping<
  TStep extends string = string,
  TPath extends string = string,
> {
  readonly __kind: "field_mapping";
  readonly step: TStep;
  readonly path: TPath;
}

/**
 * Create a field mapping marker.
 *
 * @example
 * ```typescript
 * fromStep("authorize", "code")       // top-level field
 * fromStep("exchange", "data.token")  // nested field via dot-notation
 * ```
 */
export function fromStep<TStep extends string, TPath extends string>(
  step: TStep,
  path: TPath,
): FieldMapping<TStep, TPath> {
  return {
    __kind: "field_mapping",
    step,
    path,
  };
}

/**
 * Type guard for FieldMapping.
 */
export function isFieldMapping(value: unknown): value is FieldMapping {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as Record<string, unknown>).__kind === "field_mapping"
  );
}

// =============================================================================
// Runtime Helpers
// =============================================================================

/**
 * Get a nested value from an object by dot-notation path.
 *
 * @example
 * ```typescript
 * getNestedValue({ data: { token: "abc" } }, "data.token") // "abc"
 * getNestedValue({ code: "xyz" }, "code")                   // "xyz"
 * ```
 */
export function getNestedValue(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (current, key) => {
      if (current !== null && typeof current === "object") {
        return (current as Record<string, unknown>)[key];
      }
      return undefined;
    },
    obj,
  );
}

/** Structural equality for values that can travel in a request or response. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;

  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date &&
      a.getTime() === b.getTime();
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
      a.every((item, i) => deepEqual(item, b[i]));
  }

  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  return keysA.length === keysB.length &&
    keysA.every((key) =>
      Object.hasOwn(b, key) &&
      deepEqual(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      )
    );
}

/**
 * Derive a schema that also requires the given fields to hold the given
 * values, as if each were declared `z.literal(value)`.
 *
 * The base schema is used as it is, so everything it enforces stays
 * enforced: strictness, catchall, refinements, and the field's own checks.
 * The forwarded values are compared with the raw input before the base
 * schema runs. Values are compared structurally, so an object or array
 * forwarded from an earlier response matches an equal one.
 *
 * @example
 * ```typescript
 * const base = z.object({ code: z.string(), grant_type: z.literal("authorization_code") });
 * const derived = deriveSchemaWithLiterals(base, { code: "abc123" });
 * derived.safeParse({ code: "abc123", grant_type: "authorization_code" }).success; // true
 * derived.safeParse({ code: "other", grant_type: "authorization_code" }).success;  // false
 * ```
 */
export function deriveSchemaWithLiterals(
  baseSchema: z.ZodType,
  overrides: Record<string, unknown>,
): z.ZodType {
  const fields = Object.keys(overrides);
  if (fields.length === 0) return baseSchema;

  const forwarded = z.unknown().superRefine((input, ctx) => {
    // Not an object: let the base schema report the type error.
    if (typeof input !== "object" || input === null) return;

    for (const field of fields) {
      const actual = (input as Record<string, unknown>)[field];
      if (!deepEqual(actual, overrides[field])) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `Invalid input: expected ${
            JSON.stringify(overrides[field])
          } (the value from the earlier step)`,
        });
      }
    }
  });

  return forwarded.pipe(baseSchema);
}

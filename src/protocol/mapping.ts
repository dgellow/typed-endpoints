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

/**
 * Clone a ZodObject schema, replacing specified fields with z.literal() of their actual values.
 *
 * Takes the base static schema and a record of field overrides (field name → actual value),
 * and returns a new schema where overridden fields use z.literal(actualValue).
 *
 * @example
 * ```typescript
 * const base = z.object({ code: z.string(), grant_type: z.literal("authorization_code") });
 * const derived = deriveSchemaWithLiterals(base, { code: "abc123" });
 * // derived is equivalent to:
 * // z.object({ code: z.literal("abc123"), grant_type: z.literal("authorization_code") })
 * ```
 */
export function deriveSchemaWithLiterals(
  // deno-lint-ignore no-explicit-any
  baseSchema: z.ZodObject<any>,
  overrides: Record<string, unknown>,
  // deno-lint-ignore no-explicit-any
): z.ZodObject<any> {
  const shape = { ...baseSchema.shape };

  for (const key of Object.keys(shape)) {
    if (key in overrides) {
      // deno-lint-ignore no-explicit-any
      shape[key] = z.literal(overrides[key] as any);
    }
  }

  return z.object(shape);
}

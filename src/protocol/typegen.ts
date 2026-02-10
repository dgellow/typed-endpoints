/**
 * Protocol Type Generation with Branded Provenance
 *
 * Generates TypeScript source from a protocol definition, using branded types
 * (StepOutput<T, Step, Field>) to enforce at compile time that mapped fields
 * carry the correct provenance.
 *
 * @module
 */

import type { ZodType } from "zod";
import type { Protocol } from "./types.ts";
import { isFieldMapping } from "./mapping.ts";
import { topologicalSort } from "./dsl.ts";
import { zodToTypeString } from "../tsgen/zod.ts";

// =============================================================================
// Zod Internals (same pattern as src/tsgen/zod.ts)
// =============================================================================

function getDef(schema: unknown): Record<string, unknown> {
  const s = schema as Record<string, unknown>;
  const zod = s._zod as Record<string, unknown> | undefined;
  return (zod?.def ?? s._def ?? {}) as Record<string, unknown>;
}

function getTypeName(def: Record<string, unknown>): string {
  return (def.type ?? def.typeName ?? "unknown") as string;
}

// =============================================================================
// Helpers
// =============================================================================

function toPascalCase(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function hasDescendantBrand(
  prefix: string,
  brandedPaths: Set<string>,
): boolean {
  for (const path of brandedPaths) {
    if (path.startsWith(prefix + ".")) return true;
  }
  return false;
}

// =============================================================================
// Phase 1: Collect branded outputs
// =============================================================================

function collectBrandedOutputs(
  steps: Record<string, Record<string, unknown>>,
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();

  for (const step of Object.values(steps)) {
    if (step.__kind !== "mapped_step" || !step.requestMapping) continue;

    const mapping = step.requestMapping as Record<string, unknown>;
    for (const value of Object.values(mapping)) {
      if (isFieldMapping(value)) {
        if (!result.has(value.step)) {
          result.set(value.step, new Set());
        }
        result.get(value.step)!.add(value.path);
      }
    }
  }

  return result;
}

// =============================================================================
// Phase 2: Type generation
// =============================================================================

function generateBrandedObject(
  schema: unknown,
  stepName: string,
  brandedPaths: Set<string>,
  prefix: string,
): string {
  const def = getDef(schema);
  const shape = def.shape as Record<string, unknown>;
  const entries = Object.entries(shape);

  if (entries.length === 0) return "{}";

  const props = entries.map(([key, fieldSchema]) => {
    const fullPath = prefix ? `${prefix}.${key}` : key;
    const fieldDef = getDef(fieldSchema);
    const fieldType = getTypeName(fieldDef);
    const isOptional = fieldType === "optional";
    const optionalMark = isOptional ? "?" : "";
    const innerSchema = isOptional ? fieldDef.innerType : fieldSchema;
    const innerDef = isOptional ? getDef(innerSchema) : fieldDef;
    const innerType = isOptional ? getTypeName(innerDef) : fieldType;

    if (brandedPaths.has(fullPath)) {
      const baseType = zodToTypeString(innerSchema as ZodType);
      const branded = `StepOutput<${baseType}, "${stepName}", "${fullPath}">`;
      if (isOptional) {
        return `${key}${optionalMark}: ${branded} | undefined`;
      }
      return `${key}: ${branded}`;
    }

    if (
      innerType === "object" &&
      hasDescendantBrand(fullPath, brandedPaths)
    ) {
      const nested = generateBrandedObject(
        innerSchema,
        stepName,
        brandedPaths,
        fullPath,
      );
      if (isOptional) {
        return `${key}${optionalMark}: ${nested} | undefined`;
      }
      return `${key}: ${nested}`;
    }

    const typeStr = zodToTypeString(fieldSchema as ZodType);
    return `${key}${optionalMark}: ${typeStr}`;
  });

  return `{ ${props.join("; ")}; }`;
}

function generateResponseType(
  schema: unknown,
  stepName: string,
  brandedPaths: Set<string>,
): string {
  const def = getDef(schema);
  const typeName = getTypeName(def);

  if (typeName === "union") {
    const options = def.options as unknown[];
    const variants = options.map((opt) => {
      const optDef = getDef(opt);
      if (getTypeName(optDef) === "object") {
        return generateBrandedObject(opt, stepName, brandedPaths, "");
      }
      return zodToTypeString(opt as ZodType);
    });
    return variants.join("\n  | ");
  }

  if (typeName === "object") {
    return generateBrandedObject(schema, stepName, brandedPaths, "");
  }

  return zodToTypeString(schema as ZodType);
}

function generateMappedRequestType(
  requestSchema: unknown,
  requestMapping: Record<string, unknown>,
): string {
  const def = getDef(requestSchema);
  const shape = def.shape as Record<string, unknown>;
  const entries = Object.entries(shape);

  if (entries.length === 0) return "{}";

  const props = entries.map(([key, fieldSchema]) => {
    const fieldDef = getDef(fieldSchema);
    const fieldType = getTypeName(fieldDef);
    const isOptional = fieldType === "optional";
    const optionalMark = isOptional ? "?" : "";

    const mapping = requestMapping[key];
    if (isFieldMapping(mapping)) {
      const innerSchema = isOptional ? fieldDef.innerType : fieldSchema;
      const baseType = zodToTypeString(innerSchema as ZodType);
      const branded =
        `StepOutput<${baseType}, "${mapping.step}", "${mapping.path}">`;
      if (isOptional) {
        return `${key}${optionalMark}: ${branded} | undefined`;
      }
      return `${key}: ${branded}`;
    }

    const typeStr = zodToTypeString(fieldSchema as ZodType);
    return `${key}${optionalMark}: ${typeStr}`;
  });

  return `{ ${props.join("; ")}; }`;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Generate TypeScript source with branded types for protocol provenance.
 *
 * Produces self-contained TypeScript with StepOutput<T, Step, Field> brands
 * that enforce at compile time that mapped fields carry the correct provenance.
 */
// deno-lint-ignore no-explicit-any
export function generateProtocolTypes(proto: Protocol<string, any>): string {
  const steps = proto.steps as Record<string, Record<string, unknown>>;
  const brandedOutputs = collectBrandedOutputs(steps);
  // deno-lint-ignore no-explicit-any
  const sortedSteps = topologicalSort(proto as any);

  const lines: string[] = [];

  lines.push(`// Generated types for protocol: ${proto.name}`);
  lines.push("");
  lines.push("declare const __brand: unique symbol;");
  lines.push(
    "type StepOutput<T, Step extends string, Field extends string> = T & {",
  );
  lines.push("  readonly [__brand]: [Step, Field];");
  lines.push("};");
  lines.push("");

  for (const stepName of sortedSteps) {
    const step = steps[stepName];
    if (!step) continue;

    const kind = step.__kind as string;
    if (
      kind !== "step" && kind !== "dependent_step" &&
      kind !== "mapped_step"
    ) {
      continue;
    }

    const pascal = toPascalCase(stepName);
    lines.push(`// Step: ${stepName}`);

    if (kind === "step") {
      const reqType = zodToTypeString(step.request as ZodType);
      lines.push(`export type ${pascal}Request = ${reqType};`);
    } else if (kind === "mapped_step") {
      const reqType = generateMappedRequestType(
        step.requestSchema,
        step.requestMapping as Record<string, unknown>,
      );
      lines.push(`export type ${pascal}Request = ${reqType};`);
    }

    const brands = brandedOutputs.get(stepName) ?? new Set<string>();
    const resType = generateResponseType(step.response, stepName, brands);
    lines.push(`export type ${pascal}Response = ${resType};`);

    lines.push("");
  }

  return lines.join("\n");
}

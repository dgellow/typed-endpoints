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
import { fileUrlOf } from "../core/routes.ts";
import { denoEval, isDeno } from "../core/runtime.ts";
import type { Protocol } from "./types.ts";
import { isFieldMapping } from "./mapping.ts";
import { topologicalSort } from "./dsl.ts";
import { isOptionalField, zodDef, zodType } from "../core/zod_internals.ts";
import {
  isIdentifier,
  propertyKey,
  TypeDeclarations,
  zodToTypeString,
} from "../tsgen/zod.ts";

// =============================================================================
// Helpers
// =============================================================================

/** Converts a schema to type text, collecting named (recursive) types. */
type ToType = (schema: unknown) => string;

/**
 * The prefix of the type names generated for a step.
 *
 * A step name that is an identifier keeps its spelling with the first letter
 * upper-cased (`exchange_code` -> `Exchange_code`). Any other name is split
 * at the characters an identifier cannot hold and joined in PascalCase
 * (`get-token` -> `GetToken`, `2fa` -> `_2fa`).
 */
export function stepTypeName(stepName: string): string {
  if (isIdentifier(stepName)) {
    return stepName.charAt(0).toUpperCase() + stepName.slice(1);
  }
  const joined = stepName
    .split(/[^A-Za-z0-9_$]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  if (joined === "") {
    throw new Error(
      `Cannot derive a type name from step name ${JSON.stringify(stepName)}`,
    );
  }
  return /^[0-9]/.test(joined) ? `_${joined}` : joined;
}

/** A `StepOutput` brand for a value produced by `step` at `path`. */
function brand(baseType: string, step: string, path: string): string {
  return `StepOutput<${baseType}, ${JSON.stringify(step)}, ${
    JSON.stringify(path)
  }>`;
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
  toType: ToType,
): string {
  const shape = zodDef(schema).shape as Record<string, unknown>;
  const entries = Object.entries(shape);

  if (entries.length === 0) return "{}";

  const props = entries.map(([key, fieldSchema]) => {
    const fullPath = prefix ? `${prefix}.${key}` : key;
    // `.optional()` is peeled off so the brand applies to the value type.
    const isOptionalWrapper = zodType(fieldSchema) === "optional";
    const innerSchema = isOptionalWrapper
      ? zodDef(fieldSchema).innerType
      : fieldSchema;
    const name = `${propertyKey(key)}${
      isOptionalField(fieldSchema, "output") ? "?" : ""
    }`;
    const orUndefined = isOptionalWrapper ? " | undefined" : "";

    if (brandedPaths.has(fullPath)) {
      return `${name}: ${
        brand(toType(innerSchema), stepName, fullPath)
      }${orUndefined}`;
    }

    if (
      zodType(innerSchema) === "object" &&
      hasDescendantBrand(fullPath, brandedPaths)
    ) {
      const nested = generateBrandedObject(
        innerSchema,
        stepName,
        brandedPaths,
        fullPath,
        toType,
      );
      return `${name}: ${nested}${orUndefined}`;
    }

    return `${name}: ${toType(fieldSchema)}`;
  });

  return `{ ${props.join("; ")}; }`;
}

function generateResponseType(
  schema: unknown,
  stepName: string,
  brandedPaths: Set<string>,
  toType: ToType,
): string {
  const typeName = zodType(schema);

  if (typeName === "union") {
    const options = zodDef(schema).options as unknown[];
    const variants = options.map((opt) =>
      zodType(opt) === "object"
        ? generateBrandedObject(opt, stepName, brandedPaths, "", toType)
        : toType(opt)
    );
    return variants.join("\n  | ");
  }

  if (typeName === "object") {
    return generateBrandedObject(schema, stepName, brandedPaths, "", toType);
  }

  return toType(schema);
}

function generateMappedRequestType(
  requestSchema: unknown,
  requestMapping: Record<string, unknown>,
  toType: ToType,
): string {
  const shape = zodDef(requestSchema).shape as Record<string, unknown>;
  const entries = Object.entries(shape);

  if (entries.length === 0) return "{}";

  const props = entries.map(([key, fieldSchema]) => {
    const name = `${propertyKey(key)}${
      isOptionalField(fieldSchema, "input") ? "?" : ""
    }`;

    const mapping = requestMapping[key];
    if (isFieldMapping(mapping)) {
      const isOptionalWrapper = zodType(fieldSchema) === "optional";
      const innerSchema = isOptionalWrapper
        ? zodDef(fieldSchema).innerType
        : fieldSchema;
      return `${name}: ${
        brand(toType(innerSchema), mapping.step, mapping.path)
      }${isOptionalWrapper ? " | undefined" : ""}`;
    }

    return `${name}: ${toType(fieldSchema)}`;
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

  const declarations = new TypeDeclarations();
  // A request is what the caller passes (input side); a response is what the
  // session hands back after parsing (output side).
  const toRequestType: ToType = (schema) =>
    zodToTypeString(schema as ZodType, { io: "input", declarations });
  const toResponseType: ToType = (schema) =>
    zodToTypeString(schema as ZodType, { io: "output", declarations });
  const typeNames = new Map<string, string>();

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

    const pascal = stepTypeName(stepName);
    const taken = typeNames.get(pascal);
    if (taken !== undefined) {
      throw new Error(
        `Steps ${JSON.stringify(taken)} and ${
          JSON.stringify(stepName)
        } generate the same type names (${pascal}Request, ${pascal}Response). Rename one of them.`,
      );
    }
    typeNames.set(pascal, stepName);
    lines.push(`// Step: ${stepName}`);

    if (kind === "step") {
      const reqType = toRequestType(step.request);
      lines.push(`export type ${pascal}Request = ${reqType};`);
    } else if (kind === "mapped_step") {
      const reqType = generateMappedRequestType(
        step.requestSchema,
        step.requestMapping as Record<string, unknown>,
        toRequestType,
      );
      lines.push(`export type ${pascal}Request = ${reqType};`);
    }

    const brands = brandedOutputs.get(stepName) ?? new Set<string>();
    const resType = generateResponseType(
      step.response,
      stepName,
      brands,
      toResponseType,
    );
    lines.push(`export type ${pascal}Response = ${resType};`);

    lines.push("");
  }

  // Named types for recursive schemas go after the brand, before the steps.
  if (declarations.size > 0) {
    const named = declarations.entries().map(([name, text]) =>
      `export type ${name} = ${text};`
    );
    const firstStep = lines.findIndex((line) => line.startsWith("// Step: "));
    lines.splice(
      firstStep === -1 ? lines.length : firstStep,
      0,
      "// Named types",
      ...named,
      "",
    );
  }

  return lines.join("\n");
}

const NOT_A_PROTOCOL =
  "Module must default-export or named-export 'protocol' a Protocol object";

/**
 * Generate protocol types from a module path.
 *
 * The module must default-export or named-export `protocol` a Protocol
 * object.
 *
 * On Deno the module is imported in a subprocess, so that it resolves its
 * imports through the import map of `config` (or of the `deno.json` found
 * from the working directory). On Bun and Node, which resolve imports from
 * the importing file, it is imported into this process.
 *
 * @param protocolModulePath Path to the protocol module file
 * @param config Optional path to deno.json config (for import map resolution)
 * @returns Generated TypeScript source string
 */
export async function generateProtocolTypesFromModule(
  protocolModulePath: string,
  config?: string,
): Promise<string> {
  const protocolUrl = await fileUrlOf(protocolModulePath);

  if (!isDeno()) {
    const mod = await import(protocolUrl);
    const proto = mod.default ?? mod.protocol;
    if (!proto || proto.__kind !== "protocol") {
      throw new Error(NOT_A_PROTOCOL);
    }
    return generateProtocolTypes(proto) + "\n";
  }

  const typegenUrl = new URL("./typegen.ts", import.meta.url).href;
  const script = `
    const { generateProtocolTypes } = await import("${typegenUrl}");
    const mod = await import(Deno.args[0]);
    const proto = mod.default ?? mod.protocol;
    if (!proto || proto.__kind !== "protocol") {
      console.error(${JSON.stringify(NOT_A_PROTOCOL)});
      Deno.exit(1);
    }
    console.log(generateProtocolTypes(proto));
  `;

  const { code, stdout, stderr } = await denoEval(config, script, [
    protocolUrl,
  ]);
  if (code !== 0) {
    throw new Error(stderr);
  }
  return stdout;
}

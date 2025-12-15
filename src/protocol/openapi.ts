/**
 * Protocol OpenAPI Extensions
 *
 * Converts protocol definitions to OpenAPI x-protocol extension format.
 * This enables interoperability with OpenAPI tooling while preserving
 * protocol structure and dependencies.
 *
 * @example
 * ```yaml
 * x-protocol:
 *   name: OAuth2AuthorizationCode
 *   description: OAuth 2.0 Authorization Code Grant
 *   initial: authorize
 *   terminal: [revoke]
 *   steps:
 *     - name: authorize
 *       next: [exchange]
 *     - name: exchange
 *       dependsOn: authorize
 *       next: [refresh, revoke]
 *     - name: refresh
 *       dependsOn: exchange
 * ```
 *
 * @module
 */

import { buildDependencyGraph, getStepNames, validateProtocol } from "./dsl.ts";
import type { AnyComposition, AnyStep, Protocol } from "./types.ts";

// =============================================================================
// x-protocol Extension Types
// =============================================================================

/**
 * OpenAPI x-protocol step definition.
 */
export interface XProtocolStep {
  /** Step name */
  readonly name: string;
  /** Step this depends on (for dependent steps) */
  readonly dependsOn?: string;
  /** Steps that can follow this one (derived from dependency graph) */
  readonly next?: readonly string[];
  /** Step description */
  readonly description?: string;
}

/**
 * OpenAPI x-protocol extension format.
 *
 * This format captures protocol structure in a way that's
 * compatible with OpenAPI tooling and human-readable.
 */
export interface XProtocol {
  /** Protocol name */
  readonly name: string;
  /** Protocol description */
  readonly description?: string;
  /** Initial step name */
  readonly initial: string;
  /** Terminal step names */
  readonly terminal?: readonly string[];
  /** Protocol steps with dependencies and transitions */
  readonly steps: readonly XProtocolStep[];
}

// =============================================================================
// Protocol Shape (for type constraints)
// =============================================================================

/** Minimal protocol shape for conversion functions */
interface ProtocolLike {
  readonly __kind: "protocol";
  readonly name: string;
  readonly steps: Record<string, AnyStep | AnyComposition>;
  readonly initial: string;
  readonly terminal?: readonly string[];
  readonly description?: string;
}

// =============================================================================
// Conversion Functions
// =============================================================================

/**
 * Build reverse dependency map (step → steps that depend on it).
 *
 * If step B depends on step A, then A's "next" includes B.
 */
function buildNextMap(proto: ProtocolLike): Map<string, string[]> {
  const nextMap = new Map<string, string[]>();
  const depGraph = buildDependencyGraph(proto);

  // Initialize all steps with empty next arrays
  for (const name of depGraph.keys()) {
    nextMap.set(name, []);
  }

  // For each step, add it to its dependency's "next" list
  for (const [stepName, deps] of depGraph) {
    for (const dep of deps) {
      const existing = nextMap.get(dep) ?? [];
      existing.push(stepName);
      nextMap.set(dep, existing);
    }
  }

  return nextMap;
}

/**
 * Convert a protocol to x-protocol extension format.
 *
 * @example
 * ```typescript
 * import { protocolToOpenApi, oauth2AuthCodeProtocol } from "./protocol";
 *
 * const xProtocol = protocolToOpenApi(oauth2AuthCodeProtocol);
 * // Add to OpenAPI spec:
 * // spec["x-protocol"] = xProtocol;
 * ```
 */
export function protocolToOpenApi<
  TName extends string,
  TSteps extends Record<string, { readonly __kind: string }>,
>(proto: Protocol<TName, TSteps>): XProtocol {
  const protoLike = proto as unknown as ProtocolLike;

  // Validate protocol first
  const validation = validateProtocol(protoLike);
  if (!validation.valid) {
    throw new Error(
      `Invalid protocol "${proto.name}": ${validation.errors.join(", ")}`,
    );
  }

  // Build next transitions (reverse of dependencies)
  const nextMap = buildNextMap(protoLike);

  // Build step definitions
  const steps: XProtocolStep[] = [];
  const stepNames = getStepNames(protoLike);

  for (const name of stepNames) {
    const step = protoLike.steps[name as string] as AnyStep;
    const next = nextMap.get(name as string);

    // Build step definition with optional properties
    const stepDef: XProtocolStep = {
      name: name as string,
      ...(step.__kind === "dependent_step" && { dependsOn: step.dependsOn }),
      ...(next && next.length > 0 && { next }),
      ...(step.description && { description: step.description }),
    };

    steps.push(stepDef);
  }

  // Build x-protocol object with optional properties
  return {
    name: proto.name,
    ...(proto.description && { description: proto.description }),
    initial: proto.initial as string,
    ...(proto.terminal &&
      proto.terminal.length > 0 && {
      terminal: proto.terminal.map((t) => t as string),
    }),
    steps,
  };
}

/**
 * Add x-protocol extension to an OpenAPI document.
 *
 * @example
 * ```typescript
 * const openApiSpec = await generateOpenApiSpec({ routesDir: "routes/api" });
 * const specWithProtocol = addProtocolToSpec(openApiSpec, oauth2AuthCodeProtocol);
 * ```
 */
export function addProtocolToSpec<
  TSpec extends Record<string, unknown>,
  TName extends string,
  TSteps extends Record<string, { readonly __kind: string }>,
>(
  spec: TSpec,
  proto: Protocol<TName, TSteps>,
): TSpec & { "x-protocol": XProtocol } {
  const xProtocol = protocolToOpenApi(proto);
  return {
    ...spec,
    "x-protocol": xProtocol,
  };
}

/**
 * Add multiple protocols to an OpenAPI document.
 *
 * @example
 * ```typescript
 * const specWithProtocols = addProtocolsToSpec(openApiSpec, [
 *   oauth2AuthCodeProtocol,
 *   fileSessionProtocol,
 * ]);
 * ```
 */
export function addProtocolsToSpec<TSpec extends Record<string, unknown>>(
  spec: TSpec,
  // deno-lint-ignore no-explicit-any
  protocols: Protocol<string, any>[],
): TSpec & { "x-protocols": XProtocol[] } {
  const xProtocols = protocols.map((p) => protocolToOpenApi(p));
  return {
    ...spec,
    "x-protocols": xProtocols,
  };
}

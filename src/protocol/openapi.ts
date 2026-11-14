/**
 * Protocol OpenAPI Extensions
 *
 * Converts protocol definitions to the `x-protocols` OpenAPI extension: a
 * list of protocols at the root of the document. Each step names the
 * operation it performs (`operationId`), the steps whose responses it
 * reads, the request fields it takes from them (`mappings`), and what it
 * revokes and renews.
 *
 * @example
 * ```yaml
 * x-protocols:
 *   - name: Checkout
 *     initial: login
 *     terminal: [logout]
 *     steps:
 *       - name: login
 *         kind: step
 *         operationId: authLoginCreate
 *         next: [pay, logout]
 *       - name: pay
 *         kind: mapped
 *         operationId: paymentsCreate
 *         dependsOn: login
 *         mappings:
 *           token: { step: login, path: accessToken }
 *       - name: logout
 *         kind: mapped
 *         dependsOn: login
 *         mappings:
 *           token: { step: login, path: accessToken }
 *         revokes: [login]
 * ```
 *
 * @module
 */

import {
  buildDependencyGraph,
  getStepDependencies,
  getStepNames,
  validateProtocol,
} from "./dsl.ts";
import { isFieldMapping } from "./mapping.ts";
import type { AnyComposition, AnyStep, Protocol } from "./types.ts";

// =============================================================================
// x-protocol Extension Types
// =============================================================================

/** Where a mapped step takes a request field from. */
export interface XProtocolMapping {
  /** Name of the step whose response holds the value. */
  readonly step: string;
  /** Dot-notation path of the value in that response. */
  readonly path: string;
}

/**
 * A step of a protocol in the `x-protocols` extension.
 */
export interface XProtocolStep {
  /** Step name */
  readonly name: string;
  /**
   * `step`: available at any time. `dependent`: its request schema is
   * computed from the response of `dependsOn`. `mapped`: request fields are
   * taken from earlier responses, as `mappings` says.
   */
  readonly kind: "step" | "dependent" | "mapped";
  /** `operationId` of the operation in the same document, when known. */
  readonly operationId?: string;
  /** The step whose response this one follows. */
  readonly dependsOn?: string;
  /**
   * Every step whose response this one reads, when there is one besides
   * `dependsOn`: the sources of its mappings.
   */
  readonly sources?: readonly string[];
  /** For a mapped step: where each forwarded request field comes from. */
  readonly mappings?: Readonly<Record<string, XProtocolMapping>>;
  /** Steps whose responses are no longer usable after this one. */
  readonly revokes?: readonly string[];
  /** The step whose response this step's response takes the place of. */
  readonly renews?: string;
  /**
   * Steps that read this one's response: the reverse of `dependsOn` and
   * `sources`. Not a transition relation; a step without dependencies can
   * run at any time and is not listed.
   */
  readonly next?: readonly string[];
  /** Step description */
  readonly description?: string;
}

/**
 * A protocol in the `x-protocols` extension.
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
  /** The step a client runs when it gives up before a terminal step */
  readonly onAbandon?: string;
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
  readonly onAbandon?: string;
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

    const dependsOn = step.__kind === "step" ? undefined : step.dependsOn;
    const sources = getStepDependencies(step);

    const mappings: Record<string, XProtocolMapping> = {};
    if (step.__kind === "mapped_step") {
      for (const [field, mapping] of Object.entries(step.requestMapping)) {
        if (isFieldMapping(mapping)) {
          mappings[field] = { step: mapping.step, path: mapping.path };
        }
      }
    }

    const { revokes, renews } = step as {
      revokes?: readonly string[];
      renews?: { readonly step: string };
    };

    const stepDef: XProtocolStep = {
      name: name as string,
      kind: step.__kind === "step"
        ? "step"
        : step.__kind === "mapped_step"
        ? "mapped"
        : "dependent",
      ...(step.operationId && { operationId: step.operationId }),
      ...(dependsOn && { dependsOn }),
      ...(sources.length > 1 && { sources }),
      ...(Object.keys(mappings).length > 0 && { mappings }),
      ...(revokes && revokes.length > 0 && { revokes: [...revokes] }),
      ...(renews && { renews: renews.step }),
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
    ...(proto.onAbandon !== undefined && {
      onAbandon: proto.onAbandon as string,
    }),
    steps,
  };
}

/** The protocols a document already lists. */
function listed(spec: object): XProtocol[] {
  const existing = (spec as Record<string, unknown>)["x-protocols"];
  return Array.isArray(existing) ? existing as XProtocol[] : [];
}

/**
 * Add a protocol to the `x-protocols` list of an OpenAPI document. A
 * protocol the document already lists stays: the new one is appended.
 *
 * @example
 * ```typescript
 * const openApiSpec = await generateOpenApiSpec({ routesDir: "routes/api" });
 * const specWithProtocol = addProtocolToSpec(openApiSpec, oauth2AuthCodeProtocol);
 * specWithProtocol["x-protocols"][0].name; // "OAuth2AuthorizationCode"
 * ```
 */
export function addProtocolToSpec<
  TSpec extends object,
  TName extends string,
  TSteps extends Record<string, { readonly __kind: string }>,
>(
  spec: TSpec,
  proto: Protocol<TName, TSteps>,
): TSpec & { "x-protocols": XProtocol[] } {
  return {
    ...spec,
    "x-protocols": [...listed(spec), protocolToOpenApi(proto)],
  };
}

/**
 * Add several protocols to the `x-protocols` list of an OpenAPI document.
 *
 * @example
 * ```typescript
 * const specWithProtocols = addProtocolsToSpec(openApiSpec, [
 *   oauth2AuthCodeProtocol,
 *   fileSessionProtocol,
 * ]);
 * ```
 */
export function addProtocolsToSpec<TSpec extends object>(
  spec: TSpec,
  // deno-lint-ignore no-explicit-any
  protocols: Protocol<string, any>[],
): TSpec & { "x-protocols": XProtocol[] } {
  return {
    ...spec,
    "x-protocols": [
      ...listed(spec),
      ...protocols.map((p) => protocolToOpenApi(p)),
    ],
  };
}

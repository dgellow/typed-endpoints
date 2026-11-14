/**
 * Protocol Schema DSL
 *
 * Builder functions for constructing type-safe protocol definitions.
 *
 * Inspired by André Videla's container morphisms:
 * - step() creates a Container
 * - sequence() creates Sequential Product (>>)
 * - repeat() creates Kleene Star (*)
 * - choice() creates Coproduct (+)
 * - parallel() creates Tensor (⊗)
 */

import type { z } from "zod";
import type {
  AnyComposition,
  AnyStep,
  Branch,
  Choice,
  DependentStep,
  MappedStep,
  Parallel,
  Protocol,
  Repeat,
  Sequence,
  Step,
} from "./types.ts";
import type { FieldMapping } from "./mapping.ts";
import { isFieldMapping } from "./mapping.ts";
import { lookupPath } from "./introspect.ts";

// =============================================================================
// Step Builders
// =============================================================================

/**
 * Configuration for a basic step.
 */
export interface StepConfig<
  TName extends string,
  TRequest extends z.ZodType,
  TResponse extends z.ZodType,
> {
  readonly name: TName;
  readonly request: TRequest;
  readonly response: TResponse;
  readonly description?: string;
  /** Operation ID for mapping to HTTP routes */
  readonly operationId?: string;
}

/**
 * Create a basic protocol step.
 *
 * @example
 * ```typescript
 * const login = step({
 *   name: "login",
 *   request: z.object({ username: z.string(), password: z.string() }),
 *   response: z.object({ token: z.string(), userId: z.string() }),
 * });
 * ```
 */
export function step<
  TName extends string,
  TRequest extends z.ZodType,
  TResponse extends z.ZodType,
>(
  config: StepConfig<TName, TRequest, TResponse>,
): Step<TName, TRequest, TResponse> {
  return {
    __kind: "step",
    name: config.name,
    request: config.request,
    response: config.response,
    description: config.description,
    operationId: config.operationId,
  };
}

/**
 * Configuration for a dependent step.
 */
export interface DependentStepConfig<
  TName extends string,
  TPrevResponse,
  TRequest extends z.ZodType,
  TResponse extends z.ZodType,
  TDependsOn extends string,
> {
  readonly name: TName;
  /** The step this depends on */
  readonly dependsOn: TDependsOn;
  /** Request schema derived from previous response */
  readonly request: (prev: TPrevResponse) => TRequest;
  readonly response: TResponse;
  readonly description?: string;
  /** Operation ID for mapping to HTTP routes */
  readonly operationId?: string;
}

/**
 * Create a dependent step where request depends on previous response.
 *
 * This is the key primitive from container morphisms - the sequential product.
 *
 * @example
 * ```typescript
 * const exchange = dependentStep({
 *   name: "exchange",
 *   dependsOn: "authorize",
 *   // Annotate `prev`: the previous step is known by name only.
 *   request: (prev: { code: string }) => z.object({
 *     code: z.literal(prev.code), // Use value from authorize response
 *     grant_type: z.literal("authorization_code"),
 *   }),
 *   response: z.object({ access_token: z.string() }),
 * });
 * ```
 */
export function dependentStep<
  TName extends string,
  TPrevResponse,
  TRequest extends z.ZodType,
  TResponse extends z.ZodType,
  TDependsOn extends string,
>(
  config: DependentStepConfig<
    TName,
    TPrevResponse,
    TRequest,
    TResponse,
    TDependsOn
  >,
): DependentStep<TName, TPrevResponse, TRequest, TResponse, TDependsOn> {
  return {
    __kind: "dependent_step",
    name: config.name,
    dependsOn: config.dependsOn,
    request: config.request,
    response: config.response,
    description: config.description,
    operationId: config.operationId,
  };
}

/** Keys of every member of a union. */
type KeysOfUnion<T> = T extends unknown ? keyof T : never;

/**
 * A mapping whose keys are all fields of the request schema.
 *
 * A key that is not a field maps to `never`, which makes the entry a compile
 * error. When the request type is not known statically the mapping is
 * accepted as written; `validateProtocol` still checks it.
 */
export type MappingForRequest<TMapping, TRequest extends z.ZodType> =
  unknown extends z.input<TRequest> ? TMapping
    : {
      readonly [K in keyof TMapping]: K extends KeysOfUnion<z.input<TRequest>>
        ? TMapping[K]
        : never;
    };

/**
 * Configuration for a mapped step.
 */
export interface MappedStepConfig<
  TName extends string,
  TRequest extends z.ZodType,
  TResponse extends z.ZodType,
  TDependsOn extends string,
  TMapping extends Record<string, FieldMapping>,
> {
  readonly name: TName;
  /** Primary dependency */
  readonly dependsOn: TDependsOn;
  /** Declarative field-to-step mappings */
  readonly requestMapping: TMapping;
  /** Static request schema (before literal replacement) */
  readonly requestSchema: TRequest;
  readonly response: TResponse;
  readonly description?: string;
  /** Operation ID for mapping to HTTP routes */
  readonly operationId?: string;
}

/**
 * Create a mapped step with declarative field mappings.
 *
 * The declarative form handles literal field forwarding — the most common
 * pattern in dependent steps. For conditional schemas or derived constraints,
 * use dependentStep() instead.
 *
 * @example
 * ```typescript
 * const exchangeStep = mappedStep({
 *   name: "exchange",
 *   dependsOn: "authorize",
 *   requestMapping: {
 *     code: fromStep("authorize", "code"),
 *   },
 *   requestSchema: z.object({
 *     code: z.string(),
 *     grant_type: z.literal("authorization_code"),
 *   }),
 *   response: ExchangeResponseSchema,
 * });
 * ```
 */
export function mappedStep<
  TName extends string,
  TRequest extends z.ZodType,
  TResponse extends z.ZodType,
  TDependsOn extends string,
  const TMapping extends Record<string, FieldMapping>,
>(
  config:
    & MappedStepConfig<TName, TRequest, TResponse, TDependsOn, TMapping>
    & {
      readonly requestMapping: NoInfer<MappingForRequest<TMapping, TRequest>>;
    },
): MappedStep<TName, TRequest, TResponse, TDependsOn, TMapping> {
  return {
    __kind: "mapped_step",
    name: config.name,
    dependsOn: config.dependsOn,
    requestMapping: config.requestMapping,
    requestSchema: config.requestSchema,
    response: config.response,
    description: config.description,
    operationId: config.operationId,
  };
}

// =============================================================================
// Composition Builders
// =============================================================================

/**
 * Create a sequence of steps (Sequential Product >>).
 *
 * In container theory: c1 >> c2 means the response of c1 shapes the request of c2.
 *
 * @example
 * ```typescript
 * const flow = sequence(authorize, exchange, refresh);
 * ```
 */
export function sequence<TSteps extends readonly AnyStep[]>(
  ...steps: TSteps
): Sequence<TSteps> {
  return {
    __kind: "sequence",
    steps,
  };
}

/**
 * Create a repeatable step (Kleene Star *).
 *
 * Models zero-or-more repetitions of an operation.
 *
 * @example
 * ```typescript
 * const writes = repeat(writeStep, { min: 0, max: 100 });
 * ```
 */
export function repeat<TStep extends AnyStep>(
  step: TStep,
  options?: { min?: number; max?: number },
): Repeat<TStep> {
  return {
    __kind: "repeat",
    step,
    min: options?.min,
    max: options?.max,
  };
}

/**
 * Create at-least-one repetition (Kleene Plus +).
 *
 * @example
 * ```typescript
 * const oneOrMoreWrites = repeat1(writeStep);
 * ```
 */
export function repeat1<TStep extends AnyStep>(
  step: TStep,
  options?: { max?: number },
): Repeat<TStep> {
  return {
    __kind: "repeat",
    step,
    min: 1,
    max: options?.max,
  };
}

/**
 * Create a choice between alternatives (Coproduct +).
 *
 * @example
 * ```typescript
 * const result = choice(successStep, errorStep);
 * ```
 */
export function choice<TSteps extends readonly AnyStep[]>(
  ...steps: TSteps
): Choice<TSteps> {
  return {
    __kind: "choice",
    steps,
  };
}

/**
 * Create a conditional branch based on predicate.
 *
 * @example
 * ```typescript
 * const next = branch(
 *   (prev) => prev.type === "success",
 *   { then: exchangeStep, else: errorStep }
 * );
 * ```
 */
export function branch<
  TPredicate extends (prev: unknown) => boolean,
  TThen extends AnyStep,
  TElse extends AnyStep,
>(
  predicate: TPredicate,
  branches: { then: TThen; else: TElse },
): Branch<TPredicate, TThen, TElse> {
  return {
    __kind: "branch",
    predicate,
    then: branches.then,
    else: branches.else,
  };
}

/**
 * Create parallel composition (Tensor ⊗).
 *
 * Run multiple steps simultaneously.
 *
 * @example
 * ```typescript
 * const both = parallel(fetchUser, fetchPosts);
 * ```
 */
export function parallel<TSteps extends readonly AnyStep[]>(
  ...steps: TSteps
): Parallel<TSteps> {
  return {
    __kind: "parallel",
    steps,
  };
}

// =============================================================================
// Protocol Builder
// =============================================================================

/**
 * Steps whose `name` equals the key they are registered under.
 *
 * The session, the executor and the generators identify a step by its key;
 * a different `name` would silently be ignored. A literal name that differs
 * from the key is a compile error. Names typed as plain `string` and
 * composition nodes (which have no name) are accepted.
 */
type NamedByKey<TSteps> = {
  readonly [K in keyof TSteps]: TSteps[K] extends { readonly name: infer N }
    ? string extends N ? TSteps[K]
    : K extends N ? TSteps[K]
    : TSteps[K] & { readonly name: K }
    : TSteps[K];
};

/**
 * Configuration for a protocol.
 */
export interface ProtocolConfig<
  TName extends string,
  // Use minimal constraint to avoid widening literal types in steps
  TSteps extends Record<string, { readonly __kind: string }>,
> {
  readonly name: TName;
  readonly steps: TSteps;
  readonly initial: keyof TSteps;
  readonly terminal?: readonly (keyof TSteps)[];
  readonly description?: string;
}

/**
 * Create a complete protocol definition.
 *
 * @example
 * ```typescript
 * const oauth2 = protocol({
 *   name: "OAuth2AuthorizationCode",
 *   initial: "authorize",
 *   terminal: ["authenticated", "error"],
 *   steps: {
 *     authorize: step({ ... }),
 *     exchange: dependentStep({ dependsOn: "authorize", ... }),
 *     refresh: dependentStep({ dependsOn: "exchange", ... }),
 *   },
 * });
 * ```
 */
export function protocol<
  TName extends string,
  // Use minimal constraint to preserve literal types - const ensures no widening
  const TSteps extends Record<string, { readonly __kind: string }>,
>(
  config: ProtocolConfig<TName, TSteps> & {
    readonly steps: NoInfer<NamedByKey<TSteps>>;
  },
): Protocol<TName, TSteps> {
  return {
    __kind: "protocol",
    name: config.name,
    steps: config.steps,
    initial: config.initial,
    terminal: config.terminal,
    description: config.description,
  };
}

// =============================================================================
// Protocol Introspection
// =============================================================================

/** Minimal protocol shape for introspection functions */
interface ProtocolLike {
  readonly __kind: "protocol";
  readonly name: string;
  readonly steps: Record<string, AnyStep | AnyComposition>;
  readonly initial: string;
  readonly terminal?: readonly string[];
}

/**
 * Get all step names from a protocol.
 */
export function getStepNames<T extends ProtocolLike>(
  proto: T,
): (keyof T["steps"])[] {
  return Object.keys(proto.steps) as (keyof T["steps"])[];
}

/**
 * Get dependencies for a step.
 *
 * For mapped steps, returns the primary dependsOn plus any additional steps
 * referenced in requestMapping.
 */
export function getStepDependencies(step: AnyStep): string[] {
  if (step.__kind === "dependent_step") {
    return [step.dependsOn];
  }
  if (step.__kind === "mapped_step") {
    const deps = new Set<string>([step.dependsOn]);
    for (const value of Object.values(step.requestMapping)) {
      if (isFieldMapping(value)) {
        deps.add(value.step);
      }
    }
    return [...deps];
  }
  return [];
}

/**
 * Build a dependency graph from a protocol.
 */
export function buildDependencyGraph<T extends ProtocolLike>(
  proto: T,
): Map<string, string[]> {
  const graph = new Map<string, string[]>();

  for (const [name, step] of Object.entries(proto.steps)) {
    const deps = getStepDependencies(step as AnyStep);
    graph.set(name, deps);
  }

  return graph;
}

/**
 * Topologically sort steps based on dependencies.
 */
export function topologicalSort<T extends ProtocolLike>(proto: T): string[] {
  const graph = buildDependencyGraph(proto);
  const visited = new Set<string>();
  const result: string[] = [];

  function visit(name: string): void {
    if (visited.has(name)) return;
    visited.add(name);

    const deps = graph.get(name) ?? [];
    for (const dep of deps) {
      visit(dep);
    }

    result.push(name);
  }

  for (const name of graph.keys()) {
    visit(name);
  }

  return result;
}

// =============================================================================
// Validation Helpers
// =============================================================================

/** Whether a protocol element is a step (not a composition node). */
function isStepKind(element: AnyStep | AnyComposition): element is AnyStep {
  return element.__kind === "step" || element.__kind === "dependent_step" ||
    element.__kind === "mapped_step";
}

/**
 * Validate that a protocol is well-formed.
 */
export function validateProtocol<T extends ProtocolLike>(proto: T): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // Check initial step exists
  if (!(proto.initial in proto.steps)) {
    errors.push(`Initial step "${String(proto.initial)}" not found in steps`);
  }

  // Check terminal steps exist
  if (proto.terminal) {
    for (const term of proto.terminal) {
      if (!(term in proto.steps)) {
        errors.push(`Terminal step "${String(term)}" not found in steps`);
      }
    }
  }

  // The initial step must be executable in a fresh session
  const initialStep = proto.steps[proto.initial];
  if (initialStep && isStepKind(initialStep)) {
    const deps = getStepDependencies(initialStep);
    if (deps.length > 0) {
      errors.push(
        `Initial step "${String(proto.initial)}" depends on ${
          deps.map((d) => `"${d}"`).join(", ")
        }; it can never run first`,
      );
    }
  }

  for (const [name, step] of Object.entries(proto.steps)) {
    if (!isStepKind(step)) continue;

    // Steps are identified by their key
    if (step.name !== name) {
      errors.push(
        `Step "${name}" has name "${step.name}"; the name must equal its key`,
      );
    }

    // Check dependencies exist
    for (const dep of getStepDependencies(step)) {
      if (!(dep in proto.steps)) {
        errors.push(`Step "${name}" depends on "${dep}" which doesn't exist`);
      }
    }

    if (step.__kind !== "mapped_step") continue;

    // Check each mapping against the two schemas it connects
    for (const [field, mapping] of Object.entries(step.requestMapping)) {
      if (!isFieldMapping(mapping)) continue;

      if (lookupPath(step.requestSchema, [field], "input") === "missing") {
        errors.push(
          `Step "${name}" maps field "${field}", which is not in its request schema`,
        );
      }

      const source = proto.steps[mapping.step];
      if (
        source && isStepKind(source) &&
        lookupPath(source.response, mapping.path.split("."), "output") ===
          "missing"
      ) {
        errors.push(
          `Step "${name}" maps field "${field}" from "${mapping.step}.${mapping.path}", which is not in the response schema of "${mapping.step}"`,
        );
      }
    }
  }

  // Check for circular dependencies
  const graph = buildDependencyGraph(proto);
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function hasCycle(name: string): boolean {
    if (visiting.has(name)) return true;
    if (visited.has(name)) return false;

    visiting.add(name);
    const deps = graph.get(name) ?? [];
    for (const dep of deps) {
      if (hasCycle(dep)) return true;
    }
    visiting.delete(name);
    visited.add(name);

    return false;
  }

  for (const name of graph.keys()) {
    if (hasCycle(name)) {
      errors.push(`Circular dependency detected involving "${name}"`);
      break;
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

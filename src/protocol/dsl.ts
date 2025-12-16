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
  Parallel,
  Protocol,
  Repeat,
  Sequence,
  Step,
} from "./types.ts";

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
 *   request: (prev) => z.object({
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
>(config: ProtocolConfig<TName, TSteps>): Protocol<TName, TSteps> {
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
 */
export function getStepDependencies(step: AnyStep): string[] {
  if (step.__kind === "dependent_step") {
    return [step.dependsOn];
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

  // Check dependencies exist
  for (const [name, step] of Object.entries(proto.steps)) {
    const anyStep = step as AnyStep;
    if (anyStep.__kind === "dependent_step") {
      if (!(anyStep.dependsOn in proto.steps)) {
        errors.push(
          `Step "${name}" depends on "${anyStep.dependsOn}" which doesn't exist`,
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

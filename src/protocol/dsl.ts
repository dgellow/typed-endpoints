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
  ProtocolNode,
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
  /** Step name. Must equal the step's key in `protocol({ steps })`. */
  readonly name: TName;
  /** Request schema. */
  readonly request: TRequest;
  /** Response schema. */
  readonly response: TResponse;
  /** Human-readable description. */
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
  /** Step name. Must equal the step's key in `protocol({ steps })`. */
  readonly name: TName;
  /** The step this depends on */
  readonly dependsOn: TDependsOn;
  /** Request schema derived from previous response */
  readonly request: (prev: TPrevResponse) => TRequest;
  /** Response schema. */
  readonly response: TResponse;
  /** Human-readable description. */
  readonly description?: string;
  /** Operation ID for mapping to HTTP routes */
  readonly operationId?: string;
}

/** A step that another step can name as its dependency by reference. */
export interface StepRef {
  /** Name of the step. */
  readonly name: string;
  /** Response schema of the step. */
  readonly response: z.ZodType;
}

/** The parsed response of a referenced step. */
export type StepRefResponse<T extends StepRef> = z.output<T["response"]>;

/**
 * Configuration for a dependent step that names its dependency by
 * reference, so the type of `prev` is inferred from that step's response.
 */
export interface DependentStepAfterConfig<
  TName extends string,
  TDep extends StepRef,
  TNarrow extends StepRefResponse<TDep>,
  TRequest extends z.ZodType,
  TResponse extends z.ZodType,
> {
  /** Step name. Must equal the step's key in `protocol({ steps })`. */
  readonly name: TName;
  /** The step this one follows, as the step object. */
  readonly dependsOn: TDep;
  /**
   * Which responses of `dependsOn` this step can follow.
   *
   * Written as a plain predicate, e.g. `(prev) => prev.type === "success"`:
   * TypeScript infers the type guard, and `request` receives the narrowed
   * type. A session then offers this step only once the response is known
   * to be of that type (see `ProtocolSession.narrow()`), and refuses it at
   * runtime when the guard returns false.
   */
  readonly when?: (prev: StepRefResponse<TDep>) => prev is TNarrow;
  /** Request schema derived from the (narrowed) previous response. */
  readonly request: (prev: TNarrow) => TRequest;
  /** Response schema. */
  readonly response: TResponse;
  /** Human-readable description. */
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
 *   // The step object: `prev` is typed from its response.
 *   dependsOn: authorize,
 *   // Optional: the responses this step can follow. `prev` in `request`
 *   // is narrowed to them.
 *   when: (prev) => prev.type === "success",
 *   request: (prev) => z.object({
 *     code: z.literal(prev.code), // Use value from authorize response
 *     grant_type: z.literal("authorization_code"),
 *   }),
 *   response: z.object({ access_token: z.string() }),
 * });
 * ```
 *
 * `dependsOn` also accepts the step's name. `prev` then has to be annotated:
 * `request: (prev: { code: string }) => ...`; `protocol()` checks the
 * annotation against the response of the named step.
 */
export function dependentStep<
  TName extends string,
  const TDep extends StepRef,
  TRequest extends z.ZodType,
  TResponse extends z.ZodType,
  TNarrow extends StepRefResponse<TDep> = StepRefResponse<TDep>,
>(
  config: DependentStepAfterConfig<TName, TDep, TNarrow, TRequest, TResponse>,
): DependentStep<TName, TNarrow, TRequest, TResponse, TDep["name"]>;
/**
 * Create a dependent step that names its dependency as a string.
 *
 * The type of `prev` is the annotation on `request`. `protocol()` rejects
 * an annotation that no response of the named step satisfies.
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
): DependentStep<TName, TPrevResponse, TRequest, TResponse, TDependsOn>;
export function dependentStep(
  // deno-lint-ignore no-explicit-any
  config: any,
  // deno-lint-ignore no-explicit-any
): DependentStep<string, any, z.ZodType, z.ZodType, string> {
  const dependsOn: string = typeof config.dependsOn === "string"
    ? config.dependsOn
    : config.dependsOn.name;
  return {
    __kind: "dependent_step",
    name: config.name,
    dependsOn,
    request: config.request,
    ...(config.when && { when: config.when }),
    response: config.response,
    description: config.description,
    operationId: config.operationId,
  };
}

/** Keys of every member of a union. */
export type KeysOfUnion<T> = T extends unknown ? keyof T : never;

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
  /** Step name. Must equal the step's key in `protocol({ steps })`. */
  readonly name: TName;
  /** Primary dependency */
  readonly dependsOn: TDependsOn;
  /** Declarative field-to-step mappings */
  readonly requestMapping: TMapping;
  /** Static request schema (before literal replacement) */
  readonly requestSchema: TRequest;
  /** Response schema. */
  readonly response: TResponse;
  /** Human-readable description. */
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
export function sequence<const TSteps extends readonly ProtocolNode[]>(
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
export function repeat<TStep extends ProtocolNode>(
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
export function repeat1<TStep extends ProtocolNode>(
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
export function choice<const TSteps extends readonly ProtocolNode[]>(
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
  TPredicate extends (prev: never) => boolean,
  TThen extends ProtocolNode,
  TElse extends ProtocolNode,
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
export function parallel<const TSteps extends readonly ProtocolNode[]>(
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
export type NamedByKey<TSteps> = {
  readonly [K in keyof TSteps]: TSteps[K] extends { readonly name: infer N }
    ? string extends N ? TSteps[K]
    : K extends N ? TSteps[K]
    : TSteps[K] & { readonly name: K }
    : TSteps[K];
};

/**
 * Declare that executing a step revokes earlier steps.
 *
 * After the step runs, the named steps count as not executed: their
 * responses leave the session, and steps that depend on them are no longer
 * available, at compile time and at runtime, until they run again.
 *
 * A step that revokes its own dependency consumes it. An authorization
 * code can be exchanged once (RFC 6749, section 4.1.2):
 *
 * @example
 * ```typescript
 * const exchange = revoking(
 *   dependentStep({ name: "exchange", dependsOn: authorize, ... }),
 *   ["authorize"],
 * );
 *
 * const { session } = await granted.execute("exchange", request);
 * session.execute("exchange", request); // compile error: authorize is spent
 * ```
 *
 * The session value from before the step still has its earlier type. A
 * session created with `singleUse` refuses it at runtime.
 *
 * @param step The step that revokes.
 * @param revokes Names of the steps it revokes.
 */
export function revoking<
  TStep extends { readonly __kind: string },
  const TRevoked extends string,
>(
  step: TStep,
  revokes: readonly TRevoked[],
): TStep & { readonly revokes: readonly TRevoked[] } {
  return { ...step, revokes };
}

/**
 * Steps whose `revokes` names steps of the protocol.
 *
 * A revoked name that is not a step is a compile error on that step.
 */
export type RevokesKnown<TSteps> = {
  readonly [K in keyof TSteps]: TSteps[K] extends
    { readonly revokes: readonly (infer R)[] }
    ? [R] extends [keyof TSteps] ? TSteps[K]
    : TSteps[K] & { readonly revokes: readonly (keyof TSteps)[] }
    : TSteps[K];
};

/** Members of the union `R` that a function taking `P` accepts. */
export type AcceptedBy<R, P> = R extends P ? R : never;

/**
 * Dependent steps whose `request` function can receive a response of the
 * step they depend on.
 *
 * `dependentStep({ dependsOn: "name", request: (prev: T) => ... })` names
 * its dependency as a string, so `T` is whatever the author wrote. Here,
 * where both steps are known, `T` is compared with the response type of
 * that step. It is accepted when it is a narrowing of the response (one
 * variant of a union, a refinement) or when some variant of the response
 * is assignable to it. Otherwise the step is a compile error: its
 * `request` is required to accept the actual response.
 */
export type PrevAccepted<TSteps> = {
  readonly [K in keyof TSteps]: TSteps[K] extends {
    readonly __kind: "dependent_step";
    readonly dependsOn: infer D extends keyof TSteps;
    // deno-lint-ignore no-explicit-any
    readonly request: (prev: infer P) => any;
  }
    ? TSteps[D] extends { readonly response: infer R extends z.ZodType }
      ? [P] extends [z.output<R>] ? TSteps[K]
      : [AcceptedBy<z.output<R>, P>] extends [never] ? TSteps[K] & {
          readonly request: (
            prev: z.output<R>,
          ) => z.ZodType;
        }
      : TSteps[K]
    : TSteps[K]
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
  /** Protocol name. Appears in error messages and generated output. */
  readonly name: TName;
  /** Steps by name. Each key must equal the `name` of its step. */
  readonly steps: TSteps;
  /**
   * The entry step. It must not depend on another step. A session does
   * not require it to run first.
   */
  readonly initial: keyof TSteps;
  /**
   * Steps that end the protocol. `session.isTerminal()` reports whether
   * the last executed step is one of them; a session does not stop there.
   */
  readonly terminal?: readonly (keyof TSteps)[];
  /** Human-readable description. */
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
    readonly steps: NoInfer<
      NamedByKey<TSteps> & PrevAccepted<TSteps> & RevokesKnown<TSteps>
    >;
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
export interface ProtocolLike {
  /** Discriminant. */
  readonly __kind: "protocol";
  /** Protocol name. */
  readonly name: string;
  /** Steps by name. */
  readonly steps: Record<string, AnyStep | AnyComposition>;
  /** Name of the entry step. */
  readonly initial: string;
  /** Names of the steps that end the protocol. */
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

    // Check revoked steps exist
    const revokes = (step as { revokes?: readonly string[] }).revokes ?? [];
    for (const revoked of revokes) {
      if (!(revoked in proto.steps)) {
        errors.push(`Step "${name}" revokes "${revoked}" which doesn't exist`);
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

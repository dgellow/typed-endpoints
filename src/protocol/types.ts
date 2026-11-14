/**
 * Protocol Schema Types
 *
 * Inspired by André Videla's Container Morphisms research:
 * - Container: (req : Type) × (res : req → Type)
 * - Sequential Product (>>): response of step N shapes request of step N+1
 * - Kleene Star (*): zero or more repetitions
 * - Coproduct (+): choice between alternatives
 *
 * @see https://arxiv.org/abs/2407.16713
 */

import type { z } from "zod";
import type { FieldMapping } from "./mapping.ts";

// =============================================================================
// Core Step Types
// =============================================================================

/** Where a request field is sent over HTTP. */
export type RequestLocation = "path" | "query" | "body";

/**
 * Where each field of a step's request is sent over HTTP.
 *
 * A step's request is one flat object. Steps created from an endpoint
 * (`fromEndpoint()` and friends) record which of the endpoint's `params`,
 * `query` and `body` schemas each field came from; a field declared in more
 * than one of them is sent to each place. Fields that are not listed follow
 * the HTTP executor's default rule.
 */
export type RequestLocations = Readonly<
  Record<string, readonly RequestLocation[]>
>;

/**
 * A protocol step - the basic unit of a protocol.
 *
 * Corresponds to a Container in category theory:
 * - request: the "shape" of requests
 * - response: the "positions" indexed by request
 */
export interface Step<
  TName extends string = string,
  TRequest extends z.ZodType = z.ZodType,
  TResponse extends z.ZodType = z.ZodType,
> {
  /** Discriminant. */
  readonly __kind: "step";
  /** Step name. */
  readonly name: TName;
  /** Request schema. */
  readonly request: TRequest;
  /** Response schema. */
  readonly response: TResponse;
  /** Human-readable description. */
  readonly description?: string;
  /** Operation ID for mapping to HTTP routes */
  readonly operationId?: string;
  /** Where each request field is sent over HTTP */
  readonly requestLocations?: RequestLocations;
}

/**
 * A dependent step where the request schema is derived from previous response.
 *
 * This is the key innovation from container morphisms:
 * The request type of step 2 is a FUNCTION of the response of step 1.
 *
 * In Idris: (>>) c1 c2 = (x : Σ c1.req (\r => c1.res r -> c2.req)) !> ...
 */
export interface DependentStep<
  TName extends string = string,
  TPrevResponse = unknown,
  TRequest extends z.ZodType = z.ZodType,
  TResponse extends z.ZodType = z.ZodType,
  TDependsOn extends string = string,
> {
  /** Discriminant. */
  readonly __kind: "dependent_step";
  /** Step name. */
  readonly name: TName;
  /** Request schema is derived from previous step's response */
  readonly request: (prev: TPrevResponse) => TRequest;
  /**
   * Which responses of the previous step this step can follow. `false`
   * refuses the step at runtime; `TPrevResponse` is the type the guard
   * narrows to, which a session requires at compile time.
   */
  // deno-lint-ignore no-explicit-any
  readonly when?: (prev: any) => boolean;
  /** Response schema. */
  readonly response: TResponse;
  /** The step whose response the request function receives. */
  readonly dependsOn: TDependsOn;
  /** Human-readable description. */
  readonly description?: string;
  /** Operation ID for mapping to HTTP routes */
  readonly operationId?: string;
  /** Where each request field is sent over HTTP */
  readonly requestLocations?: RequestLocations;
}

/**
 * A mapped step with declarative field mappings.
 *
 * Like DependentStep, but the dependency on previous responses is expressed
 * as plain data (requestMapping) rather than a function. This enables static
 * analysis while preserving runtime literal enforcement.
 *
 * At runtime, mapped fields are replaced with z.literal(actualValue) in the
 * request schema, giving identical behavior to dependentStep with z.literal().
 */
export interface MappedStep<
  TName extends string = string,
  TRequest extends z.ZodType = z.ZodType,
  TResponse extends z.ZodType = z.ZodType,
  TDependsOn extends string = string,
  TMapping extends Record<string, FieldMapping> = Record<string, FieldMapping>,
> {
  /** Discriminant. */
  readonly __kind: "mapped_step";
  /** Step name. */
  readonly name: TName;
  /** Static Zod schema for the request (before literal replacement) */
  readonly requestSchema: TRequest;
  /** Declarative field-to-step mappings */
  readonly requestMapping: TMapping;
  /** Response schema. */
  readonly response: TResponse;
  /** Primary dependency */
  readonly dependsOn: TDependsOn;
  /** Human-readable description. */
  readonly description?: string;
  /** Operation ID for mapping to HTTP routes */
  readonly operationId?: string;
  /** Where each request field is sent over HTTP */
  readonly requestLocations?: RequestLocations;
}

// =============================================================================
// Composition Types (Category Theory Operations)
// =============================================================================

/**
 * Anything a composition can contain: a step or another composition.
 *
 * Described by the discriminant alone, so that the composition types can
 * nest (`sequence(open, repeat(choice(read, write)), close)`) without
 * referring to each other in their constraints.
 */
export interface ProtocolNode {
  /** Discriminant: a step kind or a composition kind. */
  readonly __kind: string;
}

/**
 * Sequential composition of steps.
 *
 * Corresponds to the Sequential Product (>>) in container theory:
 * c1 >> c2 means: do c1, then based on its response, do c2.
 *
 * The response of each step flows to the next step's request.
 */
export interface Sequence<
  TSteps extends readonly ProtocolNode[] = readonly ProtocolNode[],
> {
  /** Discriminant. */
  readonly __kind: "sequence";
  /** Steps in execution order. */
  readonly steps: TSteps;
}

/**
 * Kleene star - zero or more repetitions of a step.
 *
 * From container theory: Kleene c = (StarShp c) !> (StarPos c)
 * where StarShp is Done | More (Ex c (StarShp c))
 *
 * Used for: pagination, retries, write-many-then-close patterns.
 */
export interface Repeat<TStep extends ProtocolNode = ProtocolNode> {
  /** Discriminant. */
  readonly __kind: "repeat";
  /** The repeated step. */
  readonly step: TStep;
  /** Minimum number of repetitions. */
  readonly min?: number;
  /** Maximum number of repetitions. Unbounded when omitted. */
  readonly max?: number;
}

/**
 * Choice between alternative steps (coproduct).
 *
 * Corresponds to (+) in container theory:
 * c1 + c2 = (c1.req + c2.req) !> choice c1.res c2.res
 */
export interface Choice<
  TSteps extends readonly ProtocolNode[] = readonly ProtocolNode[],
> {
  /** Discriminant. */
  readonly __kind: "choice";
  /** The alternatives. */
  readonly steps: TSteps;
}

/**
 * Conditional branching based on previous response.
 *
 * Like Choice but the branch is determined by a predicate on the response.
 */
export interface Branch<
  // `never`: a predicate may ask for any parameter type.
  TPredicate extends (prev: never) => boolean = (prev: never) => boolean,
  TThen extends ProtocolNode = ProtocolNode,
  TElse extends ProtocolNode = ProtocolNode,
> {
  /** Discriminant. */
  readonly __kind: "branch";
  /** Decides the branch from the previous response. */
  readonly predicate: TPredicate;
  /** Step taken when the predicate holds. */
  readonly then: TThen;
  /** Step taken otherwise. */
  readonly else: TElse;
}

/**
 * Parallel composition - run steps simultaneously.
 *
 * Corresponds to tensor (⊗) in container theory:
 * c1 ⊗ c2 = (c1.req × c2.req) !> (c1.res × c2.res)
 */
export interface Parallel<
  TSteps extends readonly ProtocolNode[] = readonly ProtocolNode[],
> {
  /** Discriminant. */
  readonly __kind: "parallel";
  /** Steps that run concurrently. */
  readonly steps: TSteps;
}

// =============================================================================
// Protocol Definition
// =============================================================================

/**
 * A complete protocol definition.
 *
 * A protocol is a named collection of steps with defined transitions.
 * It captures the entire flow of a multi-step interaction.
 */
export interface Protocol<
  TName extends string = string,
  // Minimal constraint to preserve literal types in steps
  TSteps extends Record<string, { readonly __kind: string }> = Record<
    string,
    AnyStep | AnyComposition
  >,
> {
  /** Discriminant. */
  readonly __kind: "protocol";
  /** Protocol name. */
  readonly name: TName;
  /** Steps by name. */
  readonly steps: TSteps;
  /** The entry step. A session does not require it to run first. */
  readonly initial: keyof TSteps;
  /** Steps that end the protocol. A session does not stop there. */
  readonly terminal?: readonly (keyof TSteps)[];
  /** Human-readable description. */
  readonly description?: string;
}

// =============================================================================
// Union Types
// =============================================================================

/** Any step type - uses `any` for variance compatibility */
export type AnyStep =
  // deno-lint-ignore no-explicit-any
  | Step<string, any, any>
  // deno-lint-ignore no-explicit-any
  | DependentStep<string, any, any, any, any>
  // deno-lint-ignore no-explicit-any
  | MappedStep<string, any, any, any, any>;

/** Any composition type */
export type AnyComposition = Sequence | Repeat | Choice | Branch | Parallel;

/** Any protocol element */
export type AnyProtocolElement = AnyStep | AnyComposition;

// =============================================================================
// Type-Level Utilities
// =============================================================================

/** Extract the request type from a step */
export type StepRequest<T extends AnyStep> = T extends Step<
  string,
  infer Req,
  z.ZodType
> ? z.infer<Req>
  : T extends DependentStep<string, unknown, infer Req, z.ZodType>
    ? z.infer<Req>
  // deno-lint-ignore no-explicit-any
  : T extends MappedStep<string, infer Req, any, any, any> ? z.infer<Req>
  : never;

/** Extract the response type from a step */
// deno-lint-ignore no-explicit-any
export type StepResponse<T> = T extends Step<string, any, infer Res>
  ? z.infer<Res>
  // deno-lint-ignore no-explicit-any
  : T extends DependentStep<string, any, any, infer Res> ? z.infer<Res>
  // deno-lint-ignore no-explicit-any
  : T extends MappedStep<string, any, infer Res, any, any> ? z.infer<Res>
  : never;

/** Extract step name */
export type StepName<T extends AnyStep> = T extends
  Step<infer N, z.ZodType, z.ZodType> ? N
  : T extends DependentStep<infer N, unknown, z.ZodType, z.ZodType> ? N
  // deno-lint-ignore no-explicit-any
  : T extends MappedStep<infer N, any, any, any, any> ? N
  : never;

/**
 * Infer the accumulated state after a sequence of steps.
 *
 * For a sequence [A, B, C], the state after each step is:
 * - After A: { a: ResponseA }
 * - After B: { a: ResponseA, b: ResponseB }
 * - After C: { a: ResponseA, b: ResponseB, c: ResponseC }
 */
export type SequenceState<
  TSteps extends readonly AnyStep[],
  TAcc extends Record<string, unknown> = Record<string, never>,
> = TSteps extends readonly [
  infer First extends AnyStep,
  ...infer Rest extends readonly AnyStep[],
] ? SequenceState<
    Rest,
    TAcc & { [K in StepName<First>]: StepResponse<First> }
  >
  : TAcc;

/**
 * Get valid next steps from a protocol state.
 *
 * This enables compile-time enforcement of protocol sequences.
 */
export type ValidNextSteps<
  TProtocol extends Protocol,
  TCurrentState extends keyof TProtocol["steps"],
> = TProtocol["steps"][TCurrentState] extends AnyStep
  ? TProtocol["steps"][TCurrentState]
  : never;

// =============================================================================
// State Machine Types
// =============================================================================

/**
 * Protocol state - tracks where we are in the protocol.
 *
 * This is used for runtime validation and compile-time type narrowing.
 */
export interface ProtocolState<
  TProtocol extends Protocol,
  TCurrentStep extends keyof TProtocol["steps"] = keyof TProtocol["steps"],
> {
  /** Name of the protocol. */
  readonly protocol: TProtocol["name"];
  /** The step the protocol is at. */
  readonly currentStep: TCurrentStep;
  /** Results of the executed steps, in order. */
  readonly history: readonly StepResult[];
  /** Values collected so far. */
  readonly data: Record<string, unknown>;
}

/**
 * Result of executing a step.
 */
export interface StepResult<TResponse = unknown> {
  /** Name of the executed step. */
  readonly step: string;
  /** When the step completed. */
  readonly timestamp: number;
  /** The step's response. */
  readonly response: TResponse;
}

// =============================================================================
// Morphism Types (for middleware/transformation)
// =============================================================================

/**
 * A protocol morphism - transforms one protocol into another.
 *
 * Corresponds to container morphism: f ⊲ f' : (a ⊳ a') → (b ⊳ b')
 * - forward: transforms requests (a → b)
 * - backward: transforms responses (b' → a')
 */
export interface ProtocolMorphism<
  TSource extends Protocol = Protocol,
  TTarget extends Protocol = Protocol,
> {
  /** Discriminant. */
  readonly __kind: "morphism";
  /** Protocol the morphism maps from. */
  readonly source: TSource;
  /** Protocol the morphism maps to. */
  readonly target: TTarget;
  /** Transforms a request of the source into a request of the target. */
  readonly forward: (req: unknown) => unknown;
  /** Transforms a response of the target into a response of the source. */
  readonly backward: (res: unknown) => unknown;
}

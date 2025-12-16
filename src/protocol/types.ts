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

// =============================================================================
// Core Step Types
// =============================================================================

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
  readonly __kind: "step";
  readonly name: TName;
  readonly request: TRequest;
  readonly response: TResponse;
  readonly description?: string;
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
  readonly __kind: "dependent_step";
  readonly name: TName;
  /** Request schema is derived from previous step's response */
  readonly request: (prev: TPrevResponse) => TRequest;
  readonly response: TResponse;
  readonly dependsOn: TDependsOn;
  readonly description?: string;
}

// =============================================================================
// Composition Types (Category Theory Operations)
// =============================================================================

/**
 * Sequential composition of steps.
 *
 * Corresponds to the Sequential Product (>>) in container theory:
 * c1 >> c2 means: do c1, then based on its response, do c2.
 *
 * The response of each step flows to the next step's request.
 */
export interface Sequence<
  TSteps extends readonly AnyStep[] = readonly AnyStep[],
> {
  readonly __kind: "sequence";
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
export interface Repeat<TStep extends AnyStep = AnyStep> {
  readonly __kind: "repeat";
  readonly step: TStep;
  readonly min?: number;
  readonly max?: number;
}

/**
 * Choice between alternative steps (coproduct).
 *
 * Corresponds to (+) in container theory:
 * c1 + c2 = (c1.req + c2.req) !> choice c1.res c2.res
 */
export interface Choice<
  TSteps extends readonly AnyStep[] = readonly AnyStep[],
> {
  readonly __kind: "choice";
  readonly steps: TSteps;
}

/**
 * Conditional branching based on previous response.
 *
 * Like Choice but the branch is determined by a predicate on the response.
 */
export interface Branch<
  TPredicate extends (prev: unknown) => boolean = (prev: unknown) => boolean,
  TThen extends AnyStep = AnyStep,
  TElse extends AnyStep = AnyStep,
> {
  readonly __kind: "branch";
  readonly predicate: TPredicate;
  readonly then: TThen;
  readonly else: TElse;
}

/**
 * Parallel composition - run steps simultaneously.
 *
 * Corresponds to tensor (⊗) in container theory:
 * c1 ⊗ c2 = (c1.req × c2.req) !> (c1.res × c2.res)
 */
export interface Parallel<
  TSteps extends readonly AnyStep[] = readonly AnyStep[],
> {
  readonly __kind: "parallel";
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
  readonly __kind: "protocol";
  readonly name: TName;
  readonly steps: TSteps;
  readonly initial: keyof TSteps;
  readonly terminal?: readonly (keyof TSteps)[];
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
  | DependentStep<string, any, any, any, any>;

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
  : never;

/** Extract the response type from a step */
// deno-lint-ignore no-explicit-any
export type StepResponse<T> = T extends Step<string, any, infer Res>
  ? z.infer<Res>
  // deno-lint-ignore no-explicit-any
  : T extends DependentStep<string, any, any, infer Res> ? z.infer<Res>
  : never;

/** Extract step name */
export type StepName<T extends AnyStep> = T extends
  Step<infer N, z.ZodType, z.ZodType> ? N
  : T extends DependentStep<infer N, unknown, z.ZodType, z.ZodType> ? N
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
  readonly protocol: TProtocol["name"];
  readonly currentStep: TCurrentStep;
  readonly history: readonly StepResult[];
  readonly data: Record<string, unknown>;
}

/**
 * Result of executing a step.
 */
export interface StepResult<TResponse = unknown> {
  readonly step: string;
  readonly timestamp: number;
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
  readonly __kind: "morphism";
  readonly source: TSource;
  readonly target: TTarget;
  readonly forward: (req: unknown) => unknown;
  readonly backward: (res: unknown) => unknown;
}

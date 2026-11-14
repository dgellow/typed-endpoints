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

/** The HTTP route a step is served at. */
export interface StepRoute {
  /** HTTP method. */
  readonly method: string;
  /** Path template with `{param}` placeholders, e.g. `/api/users/{id}`. */
  readonly path: string;
}

/** What makes a step's response an outcome of its HTTP call. */
export interface StepOutcome {
  /** Statuses of the error responses the endpoint declares. */
  readonly errors: readonly number[];
}

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
  /**
   * The route the step is served at, when the step knows it (a step made
   * with `fromEndpoint()` and a `path`). The HTTP executor then needs no
   * route table for it.
   */
  readonly route?: StepRoute;
  /**
   * Set when the step's response is an outcome, `{ ok, status, body }`
   * (`fromEndpoint()` with `outcome: true`): the error statuses the
   * endpoint declares. The HTTP executor answers those as a response and
   * does not throw for them.
   */
  readonly outcome?: StepOutcome;
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
  /**
   * The route the step is served at, when the step knows it (a step made
   * with `fromEndpoint()` and a `path`). The HTTP executor then needs no
   * route table for it.
   */
  readonly route?: StepRoute;
  /**
   * Set when the step's response is an outcome, `{ ok, status, body }`
   * (`fromEndpoint()` with `outcome: true`): the error statuses the
   * endpoint declares. The HTTP executor answers those as a response and
   * does not throw for them.
   */
  readonly outcome?: StepOutcome;
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
  /**
   * The route the step is served at, when the step knows it (a step made
   * with `fromEndpoint()` and a `path`). The HTTP executor then needs no
   * route table for it.
   */
  readonly route?: StepRoute;
  /**
   * Set when the step's response is an outcome, `{ ok, status, body }`
   * (`fromEndpoint()` with `outcome: true`): the error statuses the
   * endpoint declares. The HTTP executor answers those as a response and
   * does not throw for them.
   */
  readonly outcome?: StepOutcome;
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
 * Conditional branching on the response of an earlier step.
 *
 * Like Choice, but the side is determined by a predicate on the latest
 * response of the step named by `on`, not by the caller.
 *
 * `TTrue` and `TFalse` are what the response is known to be on each side:
 * for a type-guard predicate the narrowed type and the rest, for a plain
 * boolean predicate the response type twice.
 */
export interface Branch<
  TOn extends string = string,
  // deno-lint-ignore no-explicit-any
  TTrue = any,
  // deno-lint-ignore no-explicit-any
  TFalse = any,
  TThen extends ProtocolNode = ProtocolNode,
  TElse extends ProtocolNode = ProtocolNode,
> {
  /** Discriminant. */
  readonly __kind: "branch";
  /** Name of the step whose latest response the predicate is asked about. */
  readonly on: TOn;
  /** Decides the side from that response. */
  readonly predicate: (prev: TTrue | TFalse) => boolean;
  /** Node run when the predicate holds. */
  readonly then: TThen;
  /** Node run otherwise. */
  readonly else: TElse;
  /** Type-level only, never set: the response type on each side. */
  readonly "~sides"?: { readonly then: TTrue; readonly else: TFalse };
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
// Renewal
// =============================================================================

/**
 * What a step declares with `renewing()`: its response takes the place of
 * the latest response of another step.
 *
 * `TNew` is the type the renewed step's response then has; `TAlways` says
 * whether every response renews, or only those `combine` returns a value
 * for.
 */
export interface Renewal<
  TStep extends string = string,
  TNew = unknown,
  TAlways extends boolean = boolean,
> {
  /** Name of the step whose response is replaced. */
  readonly step: TStep;
  /** Response schema of that step; the replacement is parsed with it. */
  readonly response: z.ZodType;
  /**
   * Computes the replacement from this step's response and the response
   * it replaces (`undefined` if that step has not run). Returning
   * `undefined` leaves things as they are. Without it, this step's
   * response is the replacement.
   */
  // deno-lint-ignore no-explicit-any
  readonly combine?: (response: any, previous: any) => unknown;
  /** Type-level only, never set: the type of the replacement. */
  readonly "~new"?: TNew;
  /** Type-level only, never set: whether every response renews. */
  readonly "~always"?: TAlways;
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

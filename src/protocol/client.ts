/**
 * Protocol Client
 *
 * Type-safe execution of multi-step protocols using tagged union patterns.
 *
 * Key patterns (from TypeScript state machine best practices):
 * 1. Tagged types with discriminant fields
 * 2. Type guards for narrowing
 * 3. Each transition returns a new session with updated type
 * 4. Conditional types determine available operations
 *
 * @see https://dzone.com/articles/type-safe-state-machines-in-typescript
 * @see https://medium.com/@floyd.may/building-a-typescript-state-machine-cc9e55995fa8
 */

import type { z } from "zod";
import type {
  AnyStep,
  DependentStep,
  MappedStep,
  Protocol,
  Renewal,
  StepResponse,
} from "./types.ts";
import { zodType } from "../core/zod_internals.ts";
import { validateProtocol } from "./dsl.ts";
import {
  InvalidRequestError,
  InvalidResponseError,
  SessionAbandonedError,
  SessionEndedError,
  SessionSpentError,
  StepNotAvailableError,
  StepRefusedError,
  UnknownStepError,
} from "./errors.ts";
import {
  deriveSchemaWithLiterals,
  getNestedValue,
  isFieldMapping,
} from "./mapping.ts";

// =============================================================================
// Type Utilities
// =============================================================================

/** Check if step is independent (no dependencies) - checks __kind directly */
export type IsIndependent<T> = T extends { __kind: "step" } ? true
  : T extends { __kind: "dependent_step" } ? false
  : T extends { __kind: "mapped_step" } ? false
  : false;

/**
 * Steps named as a source in a mapped step's `requestMapping`.
 *
 * `mappedStep()` captures the mapping with a `const` type parameter, so the
 * step names are literal types. A mapping whose step names were widened to
 * `string` contributes nothing here; the runtime check still applies.
 */
export type MappingSources<T> = T extends { requestMapping: infer M } ? {
    [F in keyof M]: M[F] extends
      { __kind: "field_mapping"; step: infer S extends string }
      ? string extends S ? never : S
      : never;
  }[keyof M]
  : never;

/**
 * Every step that must have run before this one: `dependsOn`, plus for a
 * mapped step each step its `requestMapping` reads from.
 */
export type DependencyOf<T> = T extends
  { __kind: "dependent_step"; dependsOn: string } ? T["dependsOn"]
  : T extends { __kind: "mapped_step"; dependsOn: string }
    ? T["dependsOn"] | MappingSources<T>
  : never;

/**
 * The request `execute()` accepts for a step.
 *
 * - step: the input type of its request schema
 * - mapped step: the input type of its static `requestSchema`
 * - dependent step: the input type of the schema its `request` function
 *   returns. A branch that returns `z.never()` contributes nothing.
 *
 * The fields a mapped step forwards from earlier steps are optional: left
 * out, the session fills them in. Given, they are typed by their base type
 * (`code: string`), and that they equal the earlier value is checked at
 * runtime.
 */
export type StepInput<T> = T extends
  { __kind: "step"; request: infer R extends z.ZodType } ? z.input<R>
  : T extends {
    __kind: "mapped_step";
    requestSchema: infer R extends z.ZodType;
    requestMapping: infer M;
  } ? Forwarded<z.input<R>, keyof M>
  : T extends {
    __kind: "dependent_step";
    request: (prev: never) => infer R extends z.ZodType;
  } ? z.input<R>
  : never;

/**
 * A request type with the fields `TFields` optional: they are forwarded
 * from earlier responses, and the session fills in the ones left out.
 */
export type Forwarded<TInput, TFields> = TInput extends unknown ? {
    [
      K in keyof (
        & Omit<TInput, TFields & keyof TInput>
        & Partial<Pick<TInput, TFields & keyof TInput>>
      )
    ]: (
      & Omit<TInput, TFields & keyof TInput>
      & Partial<Pick<TInput, TFields & keyof TInput>>
    )[K];
  }
  : never;

// -----------------------------------------------------------------------------
// What a session knows about the responses it holds
// -----------------------------------------------------------------------------

/**
 * Response types a session has established by `narrow()`, by step name.
 *
 * A step that is not listed is known by the output type of its response
 * schema, which for a union is every variant.
 */
export type Seen = Readonly<Record<string, unknown>>;

/** No narrowing yet. */
export type NothingSeen = Readonly<Record<never, never>>;

/** What the session knows about the response of step `K`. */
export type SeenOf<
  TSteps extends Record<string, AnyStep>,
  TSeen extends Seen,
  K extends keyof TSteps,
> = K extends keyof TSeen ? TSeen[K] : StepResponse<TSteps[K]>;

/** `TSeen` with the response of `K` known as `TNarrow`. */
export type SetSeen<TSeen extends Seen, K extends string, TNarrow> = {
  readonly [P in keyof TSeen | K]: P extends K ? TNarrow
    : P extends keyof TSeen ? TSeen[P]
    : never;
};

/** `TSeen` without what was known about `K`: its response is a new one. */
export type DropSeen<TSeen extends Seen, K extends string> = {
  readonly [P in keyof TSeen as P extends K ? never : P]: TSeen[P];
};

/** Names of the steps that executing step `T` revokes (`revoking()`). */
export type RevokedBy<T> = T extends { readonly revokes: readonly (infer R)[] }
  ? R & string
  : never;

/** The step whose response every response of step `T` renews. */
export type AlwaysRenewedBy<T> = T extends
  { readonly renews: Renewal<infer S, infer _TNew, infer TAlways> }
  ? [TAlways] extends [true] ? S : never
  : never;

/** The steps that are done after step `K` ran. */
export type DoneAfter<
  TSteps extends Record<string, AnyStep>,
  TDone extends string,
  K extends keyof TSteps & string,
> = Exclude<TDone | K | AlwaysRenewedBy<TSteps[K]>, RevokedBy<TSteps[K]>>;

/**
 * `TSeen` after what step `K` renews (`renewing()`): the renewed step is
 * known by the type of the replacement, or, when not every response
 * renews, by that type or what was known before.
 */
export type RenewedSeen<
  TSteps extends Record<string, AnyStep>,
  TDone extends string,
  TSeen extends Seen,
  K extends keyof TSteps,
> = TSteps[K] extends
  { readonly renews: Renewal<infer S, infer TNew, infer TAlways> }
  ? S extends keyof TSteps & string
    ? [TAlways] extends [true] ? SetSeen<TSeen, S, TNew>
    : S extends TDone ? SetSeen<TSeen, S, SeenOf<TSteps, TSeen, S> | TNew>
    : TSeen
  : TSeen
  : TSeen;

/** What a session knows about responses after step `K` ran. */
export type SeenAfter<
  TSteps extends Record<string, AnyStep>,
  TDone extends string,
  TSeen extends Seen,
  K extends keyof TSteps & string,
> = DropSeen<
  RenewedSeen<TSteps, TDone, TSeen, K>,
  K | RevokedBy<TSteps[K]>
>;

/** The type a dependent step's `request` function accepts as `prev`. */
export type PrevOf<T> = T extends {
  __kind: "dependent_step";
  // deno-lint-ignore no-explicit-any
  request: (prev: infer P) => any;
} ? P
  : unknown;

/** Whether `T` is `any`. */
export type IsAny<T> = 0 extends 1 & T ? true : false;

/** The value under key `H`; `undefined` when `T` does not have that key. */
export type Child<T, H extends string> = T extends readonly unknown[]
  // An array may be shorter than the index: left to the runtime check.
  ? H extends `${number}` ? T[number]
  : H extends keyof T ? T[H]
  : undefined
  : H extends keyof T ? T[H]
  : undefined;

/** `HasPath` for each member of the union `T`. */
export type HasPathIn<T, P extends string> = T extends unknown
  ? P extends `${infer H}.${infer R}` ? HasPath<Child<T, H>, R>
  : undefined extends Child<T, P> ? false
  : true
  : never;

/**
 * Whether every value of type `T` has a defined value at the dot-notation
 * path `P`.
 *
 * `false` for a path through an optional property or through a union member
 * that lacks it: the value may be missing, so the type has to be narrowed
 * first. `true` where the type cannot say (`any`, `unknown`, a path typed
 * as `string`); the runtime check still applies there.
 */
export type HasPath<T, P extends string> = IsAny<T> extends true ? true
  : unknown extends T ? true
  : string extends P ? true
  : [T] extends [never] ? false
  : [HasPathIn<T, P>] extends [true] ? true
  : false;

/**
 * Whether every field a mapped step forwards has a value in what the
 * session knows about its source step.
 */
export type MappingsHold<
  TSteps extends Record<string, AnyStep>,
  TSeen extends Seen,
  T,
> = T extends { requestMapping: infer M } ? [
    {
      [F in keyof M]: M[F] extends {
        __kind: "field_mapping";
        step: infer S extends string;
        path: infer P extends string;
      } ? S extends keyof TSteps ? HasPath<SeenOf<TSteps, TSeen, S>, P>
        : true
        : true;
    }[keyof M],
  ] extends [true] ? true
  : false
  : true;

/**
 * Steps a session can execute.
 *
 * A step is available when the steps it depends on have run (`TDone`) and
 * what the session knows about their responses (`TSeen`) allows it:
 *
 * - dependent step: the response of `dependsOn` is known to be of the type
 *   its `request` function accepts
 * - mapped step: every forwarded field is known to have a value
 */
export type AvailableSteps<
  TSteps extends Record<string, AnyStep>,
  TDone extends string,
  TSeen extends Seen = NothingSeen,
> = {
  [K in keyof TSteps & string]: IsIndependent<TSteps[K]> extends true ? K
    : DependencyOf<TSteps[K]> extends TDone
      ? TSteps[K] extends
        { __kind: "dependent_step"; dependsOn: infer D extends keyof TSteps }
        ? [SeenOf<TSteps, TSeen, D>] extends [PrevOf<TSteps[K]>] ? K : never
      : MappingsHold<TSteps, TSeen, TSteps[K]> extends true ? K
      : never
    : never;
}[keyof TSteps & string];

/** The intersection of the members of the union `U`. */
export type UnionToIntersection<U> = (
  U extends unknown ? (value: U) => void : never
) extends (value: infer I) => void ? I
  : never;

/** What a step needs to be known about earlier responses, by step name. */
export type NeedsOf<T> = T extends
  { __kind: "dependent_step"; dependsOn: infer D extends string }
  ? string extends D ? NothingSeen : { readonly [K in D]: PrevOf<T> }
  : T extends { __kind: "mapped_step"; requestMapping: infer M }
    ? UnionToIntersection<
      {
        [F in keyof M]: M[F] extends {
          __kind: "field_mapping";
          step: infer S extends string;
          path: infer P extends string;
        } ? string extends S ? never
          : string extends P ? never
          : { readonly [K in S]: WithPath<P> }
          : never;
      }[keyof M]
    > extends infer N ? unknown extends N ? NothingSeen : N : never
  : NothingSeen;

/** `TSeen` with everything step `K` needs established. */
export type ReadyFor<
  TSteps extends Record<string, AnyStep>,
  TSeen extends Seen,
  K extends keyof TSteps,
> = NeedsOf<TSteps[K]> extends infer N ? {
    readonly [S in (keyof TSeen | keyof N) & string]: S extends keyof N
      ? S extends keyof TSteps ? SeenOf<TSteps, TSeen, S> & N[S] : N[S]
      : S extends keyof TSeen ? TSeen[S]
      : never;
  }
  : never;

/** Object type with a defined value at the dot-notation path `P`. */
export type WithPath<P extends string> = P extends `${infer H}.${infer R}`
  ? { readonly [K in H]: WithPath<R> }
  : { readonly [K in P]: NonNullable<unknown> };

/**
 * A guard for `ProtocolSession.narrow()`: the response has a defined value
 * at the dot-notation path.
 *
 * @example
 * ```typescript
 * const withRefresh = session.narrow("exchange", present("refresh_token"));
 * ```
 */
export function present<const P extends string>(
  path: P,
): <T>(value: T) => value is T & WithPath<P> {
  return <T>(value: T): value is T & WithPath<P> =>
    getNestedValue(value, path) !== undefined;
}

function isNeverSchema(schema: z.ZodType): boolean {
  return zodType(schema) === "never";
}

/**
 * The responses held after a step answered: the step's own response is
 * stored, a renewal (`renewing()`) replaces the renewed step's response,
 * and the responses of revoked steps (`revoking()`) are removed.
 *
 * Shared by sessions, plans and the fuzzer, so the three agree on what a
 * step does to the state.
 *
 * @param protocolName Name of the protocol, for errors.
 * @param stepName Name of the step that answered.
 * @param step The step.
 * @param responses The responses held before.
 * @param response The step's response, parsed by its schema.
 */
export function responsesAfter(
  protocolName: string,
  stepName: string,
  step: AnyStep,
  responses: Readonly<Record<string, unknown>>,
  response: unknown,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...responses, [stepName]: response };

  const renews = (step as { renews?: Renewal }).renews;
  if (renews) {
    const replacement = renews.combine
      ? renews.combine(response, responses[renews.step])
      : response;
    if (replacement !== undefined) {
      // What stands in for a step's response has to be one.
      const parsed = renews.response.safeParse(replacement);
      if (!parsed.success) {
        throw new InvalidResponseError(
          `The response of "${stepName}" cannot renew "${renews.step}": ${parsed.error.message}`,
          protocolName,
          stepName,
          parsed.error.issues,
        );
      }
      next[renews.step] = parsed.data;
    }
  }

  const revoked = (step as { revokes?: readonly string[] }).revokes ?? [];
  for (const name of revoked) delete next[name];
  return next;
}

// =============================================================================
// Executor Interface
// =============================================================================

/**
 * Performs a step: sends the request and returns the response. The
 * session validates the request before the call and the response after it.
 */
export interface StepExecutor {
  /**
   * Execute `step` with a request that passed the step's request schema.
   * The session parses the returned value with the step's response schema.
   */
  // deno-lint-ignore no-explicit-any
  execute(step: string, request: unknown, ctx: ExecutionContext): Promise<any>;
}

/** What an executor is told about the session it runs in. */
export interface ExecutionContext {
  /** Name of the protocol. */
  readonly protocol: string;
  /** Names of the steps executed so far, in order. */
  readonly history: string[];
  /** Responses of the executed steps, by step name. */
  readonly responses: Record<string, unknown>;
}

// =============================================================================
// Session State Types
// =============================================================================

/**
 * Session state - accumulates responses with their types.
 *
 * We use a mapped type to track exactly which steps have been executed
 * and what their response types are.
 */
export type SessionState<
  TSteps extends Record<string, AnyStep>,
  TDone extends keyof TSteps,
  TSeen extends Seen = NothingSeen,
> = {
  [K in TDone]: SeenOf<TSteps, TSeen, K>;
};

/**
 * Execute result - contains response and updated session.
 */
export interface ExecuteResult<
  TResponse,
  TSteps extends Record<string, AnyStep>,
  TNewDone extends keyof TSteps,
  TSeen extends Seen = NothingSeen,
> {
  /** The parsed response of the step. */
  readonly response: TResponse;
  /**
   * The session to continue with: it records the step as done. The session
   * `execute()` was called on is unchanged.
   */
  readonly session: ProtocolSession<TSteps, TNewDone, TSeen>;
}

// =============================================================================
// Protocol Session Class
// =============================================================================

/**
 * Protocol session - generic over steps, completed step names and what is
 * known about their responses.
 *
 * TDone is a union of step names that have been executed.
 * This grows as steps complete, enabling type-safe dependency tracking.
 *
 * TSeen records response types established by `narrow()`. A step that
 * needs a particular variant of an earlier response (a dependent step with
 * `when`, a mapped step forwarding a field only one variant has) is
 * available only once TSeen says the response is of that variant.
 *
 * Each method that executes a step returns a NEW session with updated types.
 *
 * A session can be ended before the protocol is: `await using` ends it
 * when the block is left, `abandon()` ends it explicitly. The protocol's
 * `onAbandon` step then runs once, on the state the session reached.
 */
export class ProtocolSession<
  TSteps extends Record<string, AnyStep>,
  TDone extends keyof TSteps = never,
  TSeen extends Seen = NothingSeen,
> {
  /** Runtime tag of session objects. */
  readonly __tag = "ProtocolSession" as const;

  /**
   * Use `createSession()`, which validates the protocol first.
   *
   * @param protocol The protocol definition.
   * @param executor Performs the steps.
   * @param responses Responses of the steps executed so far.
   * @param history Names of the steps executed so far, in order.
   */
  constructor(
    readonly protocol: {
      readonly __kind: "protocol";
      readonly name: string;
      readonly steps: TSteps;
      readonly terminal?: readonly (string | keyof TSteps)[];
      readonly onAbandon?: string | keyof TSteps;
    },
    readonly executor: StepExecutor,
    readonly responses: SessionState<TSteps, TDone, TSeen>,
    readonly history: readonly string[],
    readonly options: SessionOptions = {},
  ) {}

  /** The step this session value was used for, in a single-use session. */
  #spentBy: string | undefined;

  /** What this session value shares with the ones before and after it. */
  #line: Lineage = { latest: this, ended: false };

  /**
   * Establish that a step can run, using the step's own conditions.
   *
   * Runs the same checks as `canExecute()`: the `when` guard of a dependent
   * step, the presence of every value a mapped step forwards. When they
   * hold, the result is this session typed with what those checks prove,
   * so `execute(stepName, ...)` compiles. Otherwise the result is
   * `undefined`.
   *
   * @example
   * ```typescript
   * const { session } = await start.execute("authorize", request);
   * const granted = session.ready("exchange");
   * if (!granted) return; // authorize did not return the success variant
   * await granted.execute("exchange", { ... });
   * ```
   */
  ready<K extends keyof TSteps & string>(
    stepName: K,
  ): ProtocolSession<TSteps, TDone, ReadyFor<TSteps, TSeen, K>> | undefined {
    if (!this.canExecute(stepName)) return undefined;
    return this as unknown as ProtocolSession<
      TSteps,
      TDone,
      ReadyFor<TSteps, TSeen, K>
    >;
  }

  /**
   * Establish which variant the response of an executed step is.
   *
   * The guard runs against the stored response. When it holds, the result
   * is this session typed with the narrowed response, which makes the steps
   * that need that variant available. When it does not, the result is
   * `undefined`.
   *
   * A plain predicate is enough; TypeScript infers the type guard:
   *
   * @example
   * ```typescript
   * const { session } = await start.execute("authorize", request);
   * const granted = session.narrow("authorize", (r) => r.type === "success");
   * if (granted) {
   *   await granted.execute("exchange", { code: ..., ... });
   * }
   * ```
   */
  narrow<
    K extends TDone & string,
    TNarrow extends SeenOf<TSteps, TSeen, K>,
  >(
    stepName: K,
    guard: (response: SeenOf<TSteps, TSeen, K>) => response is TNarrow,
  ): ProtocolSession<TSteps, TDone, SetSeen<TSeen, K, TNarrow>> | undefined {
    const response = (this.responses as Record<string, unknown>)[stepName];
    if (!guard(response as SeenOf<TSteps, TSeen, K>)) return undefined;
    // Sessions are immutable: the same object, known more precisely.
    return this as unknown as ProtocolSession<
      TSteps,
      TDone,
      SetSeen<TSeen, K, TNarrow>
    >;
  }

  /**
   * Execute a step.
   *
   * Only steps that are currently available can be executed:
   * - Independent steps (no dependencies) are always available
   * - Dependent steps are available after their dependency is completed
   */
  async execute<
    K extends string & AvailableSteps<TSteps, TDone & string, TSeen>,
  >(
    stepName: K,
    request: StepInput<TSteps[K]>,
  ): Promise<
    ExecuteResult<
      StepResponse<TSteps[K]>,
      TSteps,
      DoneAfter<TSteps, TDone & string, K>,
      SeenAfter<TSteps, TDone & string, TSeen, K>
    >
  > {
    if (this.#line.ended) {
      throw new SessionEndedError(this.protocol.name, stepName);
    }
    return await this.#perform(stepName, request);
  }

  /** Execute a step, whether or not the session was ended. */
  async #perform<
    K extends string & AvailableSteps<TSteps, TDone & string, TSeen>,
  >(
    stepName: K,
    request: unknown,
  ): Promise<
    ExecuteResult<
      StepResponse<TSteps[K]>,
      TSteps,
      DoneAfter<TSteps, TDone & string, K>,
      SeenAfter<TSteps, TDone & string, TSeen, K>
    >
  > {
    const step = this.protocol.steps[stepName];

    const protocolName = this.protocol.name;

    if (!step) {
      throw new UnknownStepError(protocolName, stepName);
    }

    if (this.#spentBy !== undefined) {
      throw new SessionSpentError(protocolName, stepName, this.#spentBy);
    }

    // The schema this request has to satisfy, given the responses so far.
    const requestSchema = requestSchemaOf(
      protocolName,
      stepName,
      step,
      this.responses as Record<string, unknown>,
    );

    // Validate request, with the forwarded fields it leaves out filled in
    const reqResult = requestSchema.safeParse(
      completeRequest(step, request, this.responses as Record<string, unknown>),
    );
    if (!reqResult.success) {
      throw new InvalidRequestError(
        `Invalid request for "${stepName}": ${reqResult.error.message}`,
        protocolName,
        stepName,
        reqResult.error.issues,
      );
    }

    // Execute
    const ctx: ExecutionContext = {
      protocol: this.protocol.name,
      history: [...this.history],
      responses: this.responses as Record<string, unknown>,
    };

    const response = await this.executor.execute(
      stepName,
      reqResult.data,
      ctx,
    );

    // Validate response
    const resSchema = step.response;
    const resResult = resSchema.safeParse(response);
    if (!resResult.success) {
      throw new InvalidResponseError(
        `Invalid response from "${stepName}": ${resResult.error.message}`,
        protocolName,
        stepName,
        resResult.error.issues,
      );
    }

    // Create new session with updated state. Steps this one revokes count
    // as not executed: their responses leave the session.
    const newResponses = responsesAfter(
      protocolName,
      stepName,
      step,
      this.responses as Record<string, unknown>,
      resResult.data,
    );

    type NewDone = DoneAfter<TSteps, TDone & string, K>;
    type NewSeen = SeenAfter<TSteps, TDone & string, TSeen, K>;
    const newSession = new ProtocolSession<TSteps, NewDone, NewSeen>(
      this.protocol,
      this.executor,
      newResponses as unknown as SessionState<TSteps, NewDone, NewSeen>,
      [...this.history, stepName],
      this.options,
    );
    // The new value continues this one: ending either ends both.
    newSession.#line = this.#line;
    this.#line.latest = newSession;

    // The step succeeded: in a single-use session this value is spent.
    if (this.options.singleUse) this.#spentBy = stepName;

    return {
      response: resResult.data as StepResponse<TSteps[K]>,
      session: newSession,
    };
  }

  /**
   * Check if a step can be executed (runtime check).
   *
   * Looks at the responses the session holds, not at their types: a
   * dependent step whose `when` guard rejects the previous response, and a
   * mapped step whose source response lacks a forwarded value, are not
   * executable.
   */
  canExecute(stepName: string): boolean {
    const step = this.protocol.steps[stepName];
    if (!step) return false;
    if (step.__kind === "step") return true;
    const responses = this.responses as Record<string, unknown>;
    if (step.__kind === "mapped_step") {
      const mappedStep = step as MappedStep;
      // Check primary dependency
      if (!(mappedStep.dependsOn in responses)) return false;
      // Every forwarded field needs a value in its source response.
      for (const mapping of Object.values(mappedStep.requestMapping)) {
        if (!isFieldMapping(mapping)) continue;
        if (!(mapping.step in responses)) return false;
        if (
          getNestedValue(responses[mapping.step], mapping.path) === undefined
        ) {
          return false;
        }
      }
      return true;
    }
    const depStep = step as DependentStep;
    if (!(depStep.dependsOn in responses)) return false;
    return depStep.when ? depStep.when(responses[depStep.dependsOn]) : true;
  }

  /** Get list of available steps (runtime) */
  availableSteps(): string[] {
    return Object.keys(this.protocol.steps).filter((name) =>
      this.canExecute(name)
    );
  }

  /** Check if session has reached terminal state */
  isTerminal(): boolean {
    if (!this.protocol.terminal?.length) return false;
    const last = this.history.at(-1);
    return last !== undefined && this.protocol.terminal.includes(last);
  }

  /**
   * End the session.
   *
   * What happens depends on where the session is, counting the steps
   * executed on every value that descends from the same `createSession()`:
   *
   * - no step ran, or the last one is a terminal step: nothing
   * - otherwise the protocol's `onAbandon` step runs, with the request the
   *   session fills in from earlier responses, if the step can run in that
   *   state. In a `linear` session, `SessionAbandonedError` is thrown
   *   afterwards
   *
   * A session ends once: a second call does nothing. After it, `execute()`
   * on any value of the session throws `SessionEndedError`.
   *
   * @returns The step that ran with its request and response, or
   * `undefined` when none did.
   */
  async abandon(): Promise<Abandonment | undefined> {
    const line = this.#line;
    if (line.ended) return undefined;
    line.ended = true;

    const last = line.latest;
    if (last.history.length === 0 || last.isTerminal()) return undefined;

    const name = this.protocol.onAbandon as string | undefined;
    let released: Abandonment | undefined;
    if (name !== undefined && last.canExecute(name)) {
      const request = completeRequest(
        this.protocol.steps[name],
        {},
        last.responses as Record<string, unknown>,
      );
      const { response } = await last.#perform(name as never, request);
      released = { step: name, request, response };
    }

    if (this.options.linear) {
      throw new SessionAbandonedError(
        this.protocol.name,
        last.history,
        released?.step,
      );
    }
    return released;
  }

  /** `await using session = createSession(...)` ends the session. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.abandon();
  }
}

/** What the session values that descend from one `createSession()` share. */
interface Lineage {
  /** The value the most recent step returned. */
  // deno-lint-ignore no-explicit-any
  latest: ProtocolSession<any, any, any>;
  /** Whether the session was ended. */
  ended: boolean;
}

/** The step a session ran when it was ended early. */
export interface Abandonment {
  /** Name of the step: the protocol's `onAbandon`. */
  readonly step: string;
  /** The request the session filled in. */
  readonly request: unknown;
  /** The response, parsed by the step's schema. */
  readonly response: unknown;
}

/**
 * A request with the forwarded fields it leaves out filled in.
 *
 * For a mapped step, each field of `requestMapping` that the request does
 * not carry is taken from the response it is mapped to. A field the
 * request does carry is left as it is: the step's schema then requires it
 * to equal the forwarded value. Other steps, and requests that are not
 * objects, are returned unchanged. Shared by sessions and by `runPlan()`.
 */
export function completeRequest(
  step: AnyStep,
  request: unknown,
  responses: Readonly<Record<string, unknown>>,
): unknown {
  if (step.__kind !== "mapped_step") return request;
  if (typeof request !== "object" || request === null) return request;
  if (Array.isArray(request)) return request;

  const complete: Record<string, unknown> = { ...request };
  for (
    const [field, mapping] of Object.entries(
      (step as MappedStep).requestMapping,
    )
  ) {
    if (!isFieldMapping(mapping) || complete[field] !== undefined) continue;
    const value = getNestedValue(responses[mapping.step], mapping.path);
    if (value !== undefined) complete[field] = value;
  }
  return complete;
}

/**
 * The schema a request to `step` has to satisfy, given the responses of
 * the steps that ran before.
 *
 * - step: its request schema
 * - mapped step: its schema with every forwarded field fixed to the value
 *   in the earlier response
 * - dependent step: the schema its `request` function returns for the
 *   response of the step it depends on
 *
 * Throws `StepNotAvailableError` when a step it depends on has not run and
 * `StepRefusedError` when that step's response does not allow this one.
 * Shared by sessions and by `runPlan()`.
 */
export function requestSchemaOf(
  protocolName: string,
  stepName: string,
  step: AnyStep,
  responses: Readonly<Record<string, unknown>>,
): z.ZodType {
  let requestSchema: z.ZodType;
  if (step.__kind === "step") {
    return step.request;
  } else if (step.__kind === "mapped_step") {
    // Mapped step - derive schema with literal replacements
    const mappedStep = step as MappedStep;
    if (!(mappedStep.dependsOn in responses)) {
      throw new StepNotAvailableError(
        `Cannot execute "${stepName}": dependency "${mappedStep.dependsOn}" not satisfied`,
        protocolName,
        stepName,
        mappedStep.dependsOn,
      );
    }
    // Collect the values the mapped fields must carry.
    const overrides: Record<string, unknown> = {};
    for (
      const [field, mapping] of Object.entries(mappedStep.requestMapping)
    ) {
      if (!isFieldMapping(mapping)) continue;
      const sourceResponse = responses[mapping.step];
      if (sourceResponse === undefined) {
        throw new StepNotAvailableError(
          `Cannot execute "${stepName}": mapping source "${mapping.step}" for field "${field}" not satisfied`,
          protocolName,
          stepName,
          mapping.step,
        );
      }
      const value = getNestedValue(sourceResponse, mapping.path);
      if (value === undefined) {
        // Without this check the field would be required to be undefined,
        // and a request that leaves it out would pass.
        throw new StepRefusedError(
          `Cannot execute "${stepName}": field "${field}" is mapped from "${mapping.step}.${mapping.path}", which the response of "${mapping.step}" does not contain`,
          protocolName,
          stepName,
          mapping.step,
        );
      }
      overrides[field] = value;
    }
    requestSchema = deriveSchemaWithLiterals(
      mappedStep.requestSchema,
      overrides,
    );
  } else {
    // Dependent step - get previous response and derive schema
    const depStep = step as DependentStep;
    const prevResponse = responses[depStep.dependsOn];
    if (prevResponse === undefined) {
      throw new StepNotAvailableError(
        `Cannot execute "${stepName}": dependency "${depStep.dependsOn}" not satisfied`,
        protocolName,
        stepName,
        depStep.dependsOn,
      );
    }
    // The step states which responses it can follow.
    if (depStep.when && !depStep.when(prevResponse)) {
      throw new StepRefusedError(
        `Cannot execute "${stepName}": the response of "${depStep.dependsOn}" does not allow this step (its \`when\` guard is false)`,
        protocolName,
        stepName,
        depStep.dependsOn,
      );
    }
    requestSchema = depStep.request(prevResponse);

    // A dependent step answers a response it cannot follow with z.never().
    // No request can satisfy that, so the request is not what is wrong.
    if (isNeverSchema(requestSchema)) {
      throw new StepRefusedError(
        `Invalid request for "${stepName}": the response of "${depStep.dependsOn}" does not allow this step (its request schema is z.never())`,
        protocolName,
        stepName,
        depStep.dependsOn,
      );
    }
  }
  return requestSchema;
}

// =============================================================================
// Session Creation
// =============================================================================

/** Options of `createSession()`. */
export interface SessionOptions {
  /**
   * Each session value can execute one step. Default: false.
   *
   * `execute()` returns a new session and leaves the one it was called on
   * unchanged, with its earlier type. Without this option that earlier
   * value can still execute steps, including steps a later one revoked
   * (`revoking()`). With it, a session value that has executed a step
   * rejects further steps with `SessionSpentError`. A failed `execute()`
   * does not spend the session.
   */
  readonly singleUse?: boolean;
  /**
   * The session has to reach a terminal step. Default: false.
   *
   * Ending a session earlier (`await using`, `abandon()`) runs the
   * protocol's `onAbandon` step either way. Without this option that is
   * all (the session is affine: it may be dropped). With it, the end then
   * throws `SessionAbandonedError` (the session is linear: dropping it is
   * an error). A session on which no step ran holds nothing and is not
   * abandoned.
   */
  readonly linear?: boolean;
}

/**
 * Create initial session - no steps executed yet.
 */
export function createSession<TSteps extends Record<string, AnyStep>>(
  protocol: Protocol<string, TSteps>,
  executor: StepExecutor,
  options: SessionOptions = {},
): ProtocolSession<TSteps, never> {
  // A malformed protocol would otherwise fail at some later step, or not
  // enforce what its definition says.
  const validation = validateProtocol(
    protocol as unknown as Parameters<typeof validateProtocol>[0],
  );
  if (!validation.valid) {
    throw new Error(
      `Invalid protocol "${protocol.name}":\n${
        validation.errors.map((e) => `  ${e}`).join("\n")
      }`,
    );
  }

  return new ProtocolSession<TSteps, never>(
    protocol as {
      readonly __kind: "protocol";
      readonly name: string;
      readonly steps: TSteps;
      readonly terminal?: readonly (string | keyof TSteps)[];
      readonly onAbandon?: string | keyof TSteps;
    },
    executor,
    {} as SessionState<TSteps, never>,
    [],
    options,
  );
}

// =============================================================================
// Mock Executor
// =============================================================================

/** Mock response configuration - static value or function */
export type MockResponses<TSteps extends Record<string, AnyStep>> = {
  [K in keyof TSteps]?:
    | StepResponse<TSteps[K]>
    // deno-lint-ignore no-explicit-any
    | ((req: any) => StepResponse<TSteps[K]>);
};

/**
 * Create an executor that answers each step from `responses`: a fixed
 * value, or a function of the request. Executing a step that has no entry
 * throws.
 */
export function createMockExecutor<TSteps extends Record<string, AnyStep>>(
  _protocol: Protocol<string, TSteps>,
  responses: MockResponses<TSteps>,
): StepExecutor {
  return {
    execute: <T>(step: string, request: unknown): Promise<T> => {
      const resp = responses[step as keyof typeof responses];
      if (resp === undefined) {
        throw new Error(`No mock response configured for step: ${step}`);
      }
      return Promise.resolve(
        (typeof resp === "function" ? resp(request) : resp) as T,
      );
    },
  };
}

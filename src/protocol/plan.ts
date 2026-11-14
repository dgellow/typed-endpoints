/**
 * Plans: running a composition of steps.
 *
 * `sequence`, `repeat`, `choice`, `branch` and `parallel` describe how
 * steps combine. This module gives the descriptions a meaning, following
 * the definitions in André Videla's container work:
 *
 * - A request to `a >> b` (sequence) is a request to `a` together with a
 *   continuation from the response of `a` to a request to `b`. The
 *   response is the pair of both responses.
 * - A request to `a*` (repeat) is either "done", or a request to `a`
 *   together with a continuation from its response to a request to `a*`.
 *   The response is the list of responses.
 * - A request to `a + b` (choice) names one side and is a request to it.
 * - A request to `a ⊗ b` (parallel) is a request to each; so is the
 *   response.
 *
 * `branch` chooses a side by a predicate on the latest response of a step
 * it names; the plan supplies both sides.
 *
 * `PlanOf<Node>` is the request type of a node and `ResultOf<Node>` its
 * response type, both by recursion on the node. `runPlan()` interprets a
 * plan: it validates every request and response against the steps'
 * schemas and applies the rules a session applies (`when`, forwarded
 * values, revocation).
 *
 * `PlanOf` also computes, at every point of the node, what is known there
 * (`Known`): which steps have certainly run, and what their latest
 * response is known to be. A step whose dependency has not run, was
 * revoked, or is not known to be the variant the step can follow has no
 * plan at that point: its plan type is `NotReady`, which no value has.
 * So `sequence(exchange, authorize)` cannot be run, `sequence(authorize,
 * exchange, exchange)` cannot when `exchange` revokes `authorize`, and
 * `exchange` after an `authorize` that may have failed needs a `branch`.
 *
 * No plan has a member called `then`. A continuation may be async, and
 * JavaScript treats a value with a `then` method as a promise: such a plan
 * would be called instead of returned.
 *
 * The runner calls each continuation once, with the response it belongs
 * to. A plan has no session value that could be used twice or after it
 * went stale: what TypeScript cannot enforce for a session handle holds
 * here by construction.
 *
 * @example
 * ```ts
 * // OPEN (READ | WRITE)* CLOSE
 * const fileSession = sequence(open, repeat(choice(read, write)), close);
 *
 * const [opened, operations, closed] = await runPlan(fileSession, {
 *   first: { path: "notes.txt" },
 *   rest: (opened) => ({
 *     first: each(lines, (line) => ({
 *       choose: "write",
 *       plan: { handle: opened.handle, data: line },
 *     })),
 *     rest: () => ({ handle: opened.handle }),
 *   }),
 * }, executor);
 * ```
 *
 * @module
 */

import type {
  AnyStep,
  Branch,
  Choice,
  Parallel,
  ProtocolNode,
  Repeat,
  Sequence,
  StepResponse,
} from "./types.ts";
import {
  type ExecutionContext,
  type HasPath,
  type NeedsOf,
  type PrevOf,
  requestSchemaOf,
  type RevokedBy,
  type StepExecutor,
  type StepInput,
} from "./client.ts";
import {
  InvalidRequestError,
  InvalidResponseError,
  ProtocolError,
  StepNotAvailableError,
} from "./errors.ts";

// =============================================================================
// Types
// =============================================================================

/** How an option of a `choice` is named: a step by its name, else by index. */
export type OptionKey<TOption, TIndex> = TOption extends
  { readonly __kind: "step" | "dependent_step" | "mapped_step" }
  ? TOption extends { readonly name: infer N extends string } ? N : TIndex
  : TIndex;

/** The numeric indices of a tuple, as numbers. */
export type IndexOf<T extends readonly unknown[]> = Exclude<
  keyof T,
  keyof unknown[]
> extends infer K ? K extends `${infer N extends number}` ? N : never : never;

/**
 * The response type of a node: what `runPlan()` resolves with.
 *
 * - step: its response
 * - sequence: the tuple of its elements' results
 * - repeat: the list of results, one per run
 * - choice: `{ choice, result }` for the option that ran
 * - branch: `{ holds, result }`: whether the predicate held, and the
 *   result of the side that ran
 * - parallel: the tuple of results
 */
export type ResultOf<N> = N extends AnyStep ? StepResponse<N>
  : N extends Sequence<infer T> ? { -readonly [I in keyof T]: ResultOf<T[I]> }
  : N extends Repeat<infer S> ? ResultOf<S>[]
  : N extends Choice<infer T> ? {
      [I in IndexOf<T>]: {
        readonly choice: OptionKey<T[I], I>;
        readonly result: ResultOf<T[I]>;
      };
    }[IndexOf<T>]
  : N extends
    Branch<string, infer _TTrue, infer _TFalse, infer TThen, infer TElse> ?
      | { readonly holds: true; readonly result: ResultOf<TThen> }
      | { readonly holds: false; readonly result: ResultOf<TElse> }
  : N extends Parallel<infer T> ? { -readonly [I in keyof T]: ResultOf<T[I]> }
  : never;

// -----------------------------------------------------------------------------
// What is known at a point of a plan
// -----------------------------------------------------------------------------

/**
 * What is known at a point of a plan: for each step that has certainly
 * run and was not revoked since, the type its latest response is known to
 * have.
 */
export type Known = Readonly<Record<string, unknown>>;

/** Nothing has run. */
export type NothingKnown = Readonly<Record<never, never>>;

/** What two paths agree on: the steps known on both, by either type. */
export type Meet<A extends Known, B extends Known> = {
  readonly [P in keyof A & keyof B]: A[P] | B[P];
};

/** `K` with the response of `TName` known as `K[TName] & TNarrow`. */
export type Narrow<K extends Known, TName extends string, TNarrow> = {
  readonly [P in keyof K]: P extends TName ? K[P] & TNarrow : K[P];
};

/** Names of the steps revoked by any step inside a node. */
export type RevokesIn<N> = N extends AnyStep ? RevokedBy<N>
  : N extends Sequence<infer T> ? RevokesIn<T[number]>
  : N extends Repeat<infer S> ? RevokesIn<S>
  : N extends Choice<infer T> ? RevokesIn<T[number]>
  : N extends
    Branch<string, infer _TTrue, infer _TFalse, infer TThen, infer TElse>
    ? RevokesIn<TThen> | RevokesIn<TElse>
  : N extends Parallel<infer T> ? RevokesIn<T[number]>
  : never;

/**
 * What is known after a node has run, given what was known before it.
 *
 * - step: its response becomes known, the steps it revokes are forgotten
 * - sequence: each element in turn
 * - repeat: what holds whether it ran or not (it may run zero times)
 * - choice, branch: what every option agrees on
 * - parallel: what any arm establishes, without what any arm revokes
 */
export type After<N, K extends Known = NothingKnown> = N extends AnyStep
  ? AfterStep<N, K>
  : N extends Sequence<infer T> ? AfterEach<T, K>
  : N extends Repeat<infer S> ? Meet<K, After<S, K>>
  : N extends Choice<infer T> ? AfterAny<T, K>
  : N extends
    Branch<infer TOn, infer TTrue, infer TFalse, infer TThen, infer TElse>
    ? Meet<
      After<TThen, Narrow<K, TOn, TTrue>>,
      After<TElse, Narrow<K, TOn, TFalse>>
    >
  : N extends Parallel<infer T> ? AfterAll<T, K>
  : K;

/** `After` for a step. */
export type AfterStep<N, K extends Known> = N extends
  { readonly name: infer TName extends string } ? {
    readonly [P in Exclude<keyof K | TName, RevokedBy<N>>]: P extends TName
      ? StepResponse<N>
      : P extends keyof K ? K[P]
      : never;
  }
  : K;

/** `After` for the elements of a sequence, in order. */
export type AfterEach<T extends readonly unknown[], K extends Known> = T extends
  readonly [infer H, ...infer R] ? AfterEach<R, After<H, K>> : K;

/** `After` for the options of a choice: what every option agrees on. */
export type AfterAny<T extends readonly unknown[], K extends Known> = T extends
  readonly [infer H] ? After<H, K>
  : T extends readonly [infer H, ...infer R] ? Meet<After<H, K>, AfterAny<R, K>>
  : K;

/** `After` for the arms of a parallel node, each of which starts from `K`. */
export type AfterAll<T extends readonly unknown[], K extends Known> =
  After<T[number], K> extends infer TArms ? {
      readonly [
        P in Exclude<
          TArms extends unknown ? keyof TArms : never,
          RevokesIn<T[number]>
        >
      ]: TArms extends unknown ? P extends keyof TArms ? TArms[P] : never
        : never;
    }
    : never;

/**
 * Whether a step can run with what is known: its dependency has run and
 * its response is of the type the step can follow; for a mapped step,
 * every forwarded field is known to have a value.
 */
export type IsReady<N, K extends Known> = N extends {
  readonly __kind: "dependent_step";
  readonly dependsOn: infer D extends string;
} ? string extends D ? true
  : D extends keyof K ? [K[D]] extends [PrevOf<N>] ? true : false
  : false
  : N extends {
    readonly __kind: "mapped_step";
    readonly dependsOn: infer D extends string;
    readonly requestMapping: infer M;
  } ? string extends D ? true
    : D extends keyof K ? [
        {
          [F in keyof M]: M[F] extends {
            readonly __kind: "field_mapping";
            readonly step: infer S extends string;
            readonly path: infer P extends string;
          } ? string extends S ? true
            : S extends keyof K ? HasPath<K[S], P>
            : false
            : true;
        }[keyof M],
      ] extends [true] ? true
      : false
    : false
  : true;

/**
 * The plan type of a step that cannot run where it stands. No value has
 * this type; its members say why.
 */
export interface NotReady<TStep, TNeeds, TKnown> {
  /** The step that cannot run. */
  readonly "this step cannot run here": TStep;
  /** What it needs to be known about earlier responses. */
  readonly "it needs": TNeeds;
  /** What is known where it stands. */
  readonly "known here": TKnown;
  /** Makes the type uninhabited. */
  readonly "no plan exists": never;
}

/** The plan type of a branch on a step that has not run where it stands. */
export interface BranchNotReady<TOn, TKnown> {
  /** The step the branch asks about. */
  readonly "this branch asks about a step that has not run": TOn;
  /** What is known where it stands. */
  readonly "known here": TKnown;
  /** Makes the type uninhabited. */
  readonly "no plan exists": never;
}

// -----------------------------------------------------------------------------
// Plans
// -----------------------------------------------------------------------------

/**
 * The request type of a node: what a caller passes to `runPlan()`.
 *
 * - step: its request; `NotReady` when the step cannot run with what is
 *   known at that point
 * - sequence: `{ first, rest }`, see `SequencePlan`
 * - repeat: `undefined` or `{ next, rest }`, see `RepeatPlan`
 * - choice: `{ choose, plan }` for one option
 * - branch: `{ ifTrue, ifFalse }`, a plan per side as a function of the
 *   response the predicate was asked about, see `BranchPlan`
 * - parallel: the tuple of plans
 *
 * `K` is what is known before the node; nothing, for the node passed to
 * `runPlan()`.
 */
export type PlanOf<N, K extends Known = NothingKnown> = N extends AnyStep
  ? IsReady<N, K> extends true ? StepInput<N>
  : NotReady<N["name"], NeedsOf<N>, K>
  : N extends Sequence<infer T> ? SequencePlan<T, K>
  : N extends Repeat<infer S> ? RepeatPlan<S, Meet<K, After<S, K>>>
  : N extends Choice<infer T> ? {
      [I in IndexOf<T>]: {
        readonly choose: OptionKey<T[I], I>;
        readonly plan: PlanOf<T[I], K>;
      };
    }[IndexOf<T>]
  : N extends
    Branch<infer TOn, infer TTrue, infer TFalse, infer TThen, infer TElse>
    ? BranchPlan<TOn, TTrue, TFalse, TThen, TElse, K>
  : N extends Parallel<infer T> ? { readonly [I in keyof T]: PlanOf<T[I], K> }
  : never;

/**
 * The plan of a sequence: the plan of its first element, and a
 * continuation that receives that element's result and returns the plan
 * of the rest. A sequence of one element is that element's plan; the
 * empty sequence has the plan `undefined`.
 *
 * The continuation is where a later request uses an earlier response:
 * the dependency is a closure.
 */
export type SequencePlan<
  T extends readonly unknown[],
  K extends Known = NothingKnown,
> = T extends readonly [] ? undefined
  : T extends readonly [infer H] ? PlanOf<H, K>
  : T extends readonly [infer H, ...infer R] ? {
      /** The plan of the first element. */
      readonly first: PlanOf<H, K>;
      /** From the first element's result to the plan of the rest. */
      readonly rest: (
        result: ResultOf<H>,
      ) => SequencePlan<R, After<H, K>> | Promise<SequencePlan<R, After<H, K>>>;
    }
  : never;

/**
 * The plan of a repetition: `undefined` to stop, or the plan of one run
 * and a continuation that receives its result and decides what follows.
 *
 * `K` is what is known at the start of every run: what was known before
 * the repetition, less what a run revokes.
 */
export type RepeatPlan<S, K extends Known = NothingKnown> = undefined | {
  /** The plan of the next run. */
  readonly next: PlanOf<S, K>;
  /** From that run's result to the plan of the remaining runs. */
  readonly rest: (
    result: ResultOf<S>,
  ) => RepeatPlan<S, K> | Promise<RepeatPlan<S, K>>;
};

/** What `each()` returns: a repeat plan that ignores the results. */
export type EachPlan<TPlan> = undefined | {
  /** The plan of the next run. */
  readonly next: TPlan;
  /** The plan of the remaining runs. */
  readonly rest: () => EachPlan<TPlan>;
};

/**
 * The plan of a branch: a plan for each side, as a function of the
 * response the predicate was asked about. Each side receives the response
 * as the type it is known to have there, and its plan is typed with that
 * knowledge: on the `then` side of a type guard, a step that can only
 * follow the narrowed response is ready.
 */
export type BranchPlan<
  TOn extends string,
  TTrue,
  TFalse,
  TThen,
  TElse,
  K extends Known = NothingKnown,
> = TOn extends keyof K ? {
    /** The plan of the `then` side: the predicate holds. */
    readonly ifTrue: (
      prev: K[TOn] & TTrue,
    ) =>
      | PlanOf<TThen, Narrow<K, TOn, TTrue>>
      | Promise<PlanOf<TThen, Narrow<K, TOn, TTrue>>>;
    /** The plan of the `else` side: it does not. */
    readonly ifFalse: (
      prev: K[TOn] & TFalse,
    ) =>
      | PlanOf<TElse, Narrow<K, TOn, TFalse>>
      | Promise<PlanOf<TElse, Narrow<K, TOn, TFalse>>>;
  }
  : string extends TOn ? {
      /** The plan of the `then` side: the predicate holds. */
      readonly ifTrue: (
        prev: TTrue,
      ) => PlanOf<TThen, K> | Promise<PlanOf<TThen, K>>;
      /** The plan of the `else` side: it does not. */
      readonly ifFalse: (
        prev: TFalse,
      ) => PlanOf<TElse, K> | Promise<PlanOf<TElse, K>>;
    }
  : BranchNotReady<TOn, K>;

// =============================================================================
// Errors
// =============================================================================

/** A plan does not fit the node it is run against. */
export class PlanError extends ProtocolError {
  /**
   * Create the error.
   *
   * @param message What does not fit.
   * @param protocol Name given to the run.
   * @param at Where in the node tree, e.g. `sequence[1].repeat`.
   */
  constructor(
    message: string,
    protocol: string,
    /** Where in the node tree, e.g. `sequence[1].repeat`. */
    readonly at: string,
  ) {
    super(`${at}: ${message}`, protocol, at);
  }
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * The plan of a repetition that runs once per item, in order.
 *
 * @param items What to run for.
 * @param plan The plan of the run for one item.
 */
export function each<TItem, TPlan>(
  items: readonly TItem[],
  plan: (item: TItem, index: number) => TPlan,
): EachPlan<TPlan> {
  const from = (index: number): EachPlan<TPlan> =>
    index >= items.length ? undefined : {
      next: plan(items[index], index),
      rest: () => from(index + 1),
    };
  return from(0);
}

// =============================================================================
// Runner
// =============================================================================

/** Options of `runPlan()`. */
export interface RunPlanOptions {
  /** Name of the run, for error messages. Default: `"plan"`. */
  readonly name?: string;
  /**
   * A bound on the runs of one repetition, against a plan that never
   * stops. Default: 10000.
   */
  readonly maxRepetitions?: number;
}

interface Run {
  readonly name: string;
  readonly executor: StepExecutor;
  readonly maxRepetitions: number;
  /** Latest response of each step that ran, by step name. */
  readonly responses: Record<string, unknown>;
  /** Names of the steps that ran, in completion order. */
  readonly history: string[];
  /** What ran in this run, for a parallel node to merge into its parent. */
  readonly events: StepEvent[];
}

interface StepEvent {
  readonly name: string;
  readonly response: unknown;
  readonly revokes: readonly string[];
}

function record(run: Run, event: StepEvent): void {
  run.responses[event.name] = event.response;
  run.history.push(event.name);
  for (const name of event.revokes) delete run.responses[name];
  run.events.push(event);
}

function isStep(node: ProtocolNode): node is AnyStep {
  return node.__kind === "step" || node.__kind === "dependent_step" ||
    node.__kind === "mapped_step";
}

async function runStep(
  step: AnyStep,
  request: unknown,
  run: Run,
): Promise<unknown> {
  const requestSchema = requestSchemaOf(
    run.name,
    step.name,
    step,
    run.responses,
  );
  const parsedRequest = requestSchema.safeParse(request);
  if (!parsedRequest.success) {
    throw new InvalidRequestError(
      `Invalid request for "${step.name}": ${parsedRequest.error.message}`,
      run.name,
      step.name,
      parsedRequest.error.issues,
    );
  }

  const context: ExecutionContext = {
    protocol: run.name,
    history: [...run.history],
    responses: { ...run.responses },
  };
  const response = await run.executor.execute(
    step.name,
    parsedRequest.data,
    context,
  );

  const parsedResponse = step.response.safeParse(response);
  if (!parsedResponse.success) {
    throw new InvalidResponseError(
      `Invalid response from "${step.name}": ${parsedResponse.error.message}`,
      run.name,
      step.name,
      parsedResponse.error.issues,
    );
  }

  record(run, {
    name: step.name,
    response: parsedResponse.data,
    revokes: (step as { revokes?: readonly string[] }).revokes ?? [],
  });
  return parsedResponse.data;
}

/** A plan part that must be an object with the given keys. */
function shape<K extends string>(
  plan: unknown,
  keys: readonly K[],
  run: Run,
  at: string,
): Record<K, unknown> {
  if (
    typeof plan !== "object" || plan === null ||
    keys.some((key) => !(key in plan))
  ) {
    throw new PlanError(
      `expected a plan with ${keys.map((k) => `\`${k}\``).join(" and ")}`,
      run.name,
      at,
    );
  }
  return plan as Record<K, unknown>;
}

async function runNode(
  node: ProtocolNode,
  plan: unknown,
  run: Run,
  at: string,
): Promise<unknown> {
  if (isStep(node)) return await runStep(node, plan, run);

  switch (node.__kind) {
    case "sequence": {
      const { steps } = node as Sequence;
      const results: unknown[] = [];
      let rest = plan;
      for (let i = 0; i < steps.length; i++) {
        const here = `${at}[${i}]`;
        const last = i === steps.length - 1;
        const current = last ? rest : shape(rest, ["first", "rest"], run, here);
        const result = await runNode(
          steps[i],
          last ? current : (current as { first: unknown }).first,
          run,
          here,
        );
        results.push(result);
        if (!last) {
          const next = (current as { rest: unknown }).rest;
          if (typeof next !== "function") {
            throw new PlanError("`rest` is not a function", run.name, here);
          }
          // Called once, with the result it belongs to.
          rest = await next(result);
        }
      }
      return results;
    }

    case "repeat": {
      const { step, min = 0, max } = node as Repeat;
      const results: unknown[] = [];
      let rest = plan;
      while (rest !== undefined) {
        const here = `${at}[${results.length}]`;
        if (max !== undefined && results.length >= max) {
          throw new PlanError(
            `the plan asks for more than the ${max} repetitions the node allows`,
            run.name,
            at,
          );
        }
        if (results.length >= run.maxRepetitions) {
          throw new PlanError(
            `stopped after ${run.maxRepetitions} repetitions; the plan may never return undefined`,
            run.name,
            at,
          );
        }
        const current = shape(rest, ["next", "rest"], run, here);
        const result = await runNode(step, current.next, run, here);
        results.push(result);
        if (typeof current.rest !== "function") {
          throw new PlanError("`rest` is not a function", run.name, here);
        }
        rest = await current.rest(result);
      }
      if (results.length < min) {
        throw new PlanError(
          `the plan stops after ${results.length} repetitions; the node requires at least ${min}`,
          run.name,
          at,
        );
      }
      return results;
    }

    case "choice": {
      const { steps } = node as Choice;
      const { choose, plan: chosenPlan } = shape(
        plan,
        ["choose", "plan"],
        run,
        at,
      );
      const index = steps.findIndex((option, i) =>
        isStep(option) ? option.name === choose : i === choose
      );
      if (index === -1) {
        throw new PlanError(
          `no option ${JSON.stringify(choose)}`,
          run.name,
          at,
        );
      }
      const result = await runNode(
        steps[index],
        chosenPlan,
        run,
        `${at}<${String(choose)}>`,
      );
      return { choice: choose, result };
    }

    case "branch": {
      const branchNode = node as Branch;
      const sides = shape(plan, ["ifTrue", "ifFalse"], run, at);
      if (!(branchNode.on in run.responses)) {
        throw new StepNotAvailableError(
          `A branch asks about "${branchNode.on}", which has not been executed`,
          run.name,
          at,
          branchNode.on,
        );
      }
      const asked = run.responses[branchNode.on];
      const holds = branchNode.predicate(asked) === true;
      const key = holds ? "ifTrue" : "ifFalse";
      const side = holds ? "then" : "else";
      const planOf = sides[key];
      if (typeof planOf !== "function") {
        throw new PlanError(`\`${key}\` is not a function`, run.name, at);
      }
      const result = await runNode(
        branchNode[side],
        await planOf(asked),
        run,
        `${at}.${side}`,
      );
      return { holds, result };
    }

    case "parallel": {
      const { steps } = node as Parallel;
      if (!Array.isArray(plan) || plan.length !== steps.length) {
        throw new PlanError(
          `expected a tuple of ${steps.length} plans`,
          run.name,
          at,
        );
      }
      // Each arm runs on its own copy of what is known, so no arm sees a
      // response of another; what they did is merged in the order of the
      // arms. The node settles when every arm has: no step is in flight
      // when it rejects.
      const arms = steps.map((): Run => ({
        ...run,
        responses: { ...run.responses },
        history: [...run.history],
        events: [],
      }));
      const settled = await Promise.allSettled(
        steps.map((step, i) => runNode(step, plan[i], arms[i], `${at}[${i}]`)),
      );
      for (const arm of arms) {
        for (const event of arm.events) record(run, event);
      }
      const results: unknown[] = [];
      for (const outcome of settled) {
        if (outcome.status === "rejected") throw outcome.reason;
        results.push(outcome.value);
      }
      return results;
    }

    default:
      throw new PlanError(
        `unknown node kind ${JSON.stringify(node.__kind)}`,
        run.name,
        at,
      );
  }
}

/**
 * Run a plan against a node.
 *
 * Every request is validated against its step's schema before the
 * executor sees it, and every response after. A dependent or mapped step
 * reads the latest response of the step it depends on, wherever in the
 * plan that step ran; its `when` guard and forwarded values are enforced
 * as in a session, and a revoking step removes the responses it revokes.
 * The arms of a `parallel` node each start from what was known before the
 * node and do not see each other's responses.
 *
 * `PlanOf` rejects a plan in which a step would run before what it depends
 * on is known. The same conditions are checked when the plan runs, for a
 * plan that got past the types.
 *
 * Rejects with the errors a session raises (`InvalidRequestError`,
 * `StepRefusedError`, ...), with `PlanError` when the plan does not have
 * the shape of the node, and with whatever a continuation throws.
 *
 * @param node A step or a composition of steps.
 * @param plan The request: see `PlanOf`.
 * @param executor Performs the steps.
 */
export async function runPlan<const N extends ProtocolNode>(
  node: N,
  plan: PlanOf<N>,
  executor: StepExecutor,
  options: RunPlanOptions = {},
): Promise<ResultOf<N>> {
  const run: Run = {
    name: options.name ?? "plan",
    executor,
    maxRepetitions: options.maxRepetitions ?? 10000,
    responses: {},
    history: [],
    events: [],
  };
  const at = isStep(node) ? node.name : node.__kind;
  return await runNode(node, plan, run, at) as ResultOf<N>;
}

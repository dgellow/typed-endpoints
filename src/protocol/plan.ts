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
 * `branch` is the one node that reads a value on its own: its predicate is
 * asked about the result of the node before it in the enclosing sequence
 * (through any `repeat`, `choice` or `parallel` around it), and the plan
 * supplies one side each. A sequence whose branch cannot be asked about
 * the result before it has no plan: the mismatch is a compile error.
 *
 * `PlanOf<Node>` is the request type of a node and `ResultOf<Node>` its
 * response type, both by recursion on the node. `runPlan()` interprets a
 * plan: it validates every request and response against the steps'
 * schemas and applies the rules a session applies (`when`, forwarded
 * values, revocation).
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
  requestSchemaOf,
  type StepExecutor,
  type StepInput,
} from "./client.ts";
import {
  InvalidRequestError,
  InvalidResponseError,
  ProtocolError,
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
  : N extends Branch<infer _P, infer TThen, infer TElse> ?
      | { readonly holds: true; readonly result: ResultOf<TThen> }
      | { readonly holds: false; readonly result: ResultOf<TElse> }
  : N extends Parallel<infer T> ? { -readonly [I in keyof T]: ResultOf<T[I]> }
  : never;

/**
 * The request type of a node: what a caller passes to `runPlan()`.
 *
 * - step: its request
 * - sequence: `{ first, rest }`, see `SequencePlan`
 * - repeat: `undefined` or `{ next, rest }`, see `RepeatPlan`
 * - choice: `{ choose, plan }` for one option
 * - branch: one plan per side, each a function of the value the predicate
 *   was asked about, see `BranchPlan`
 * - parallel: the tuple of plans
 */
export type PlanOf<N> = N extends AnyStep ? StepInput<N>
  : N extends Sequence<infer T> ? SequencePlan<T>
  : N extends Repeat<infer S> ? RepeatPlan<S>
  : N extends Choice<infer T> ? {
      [I in IndexOf<T>]: {
        readonly choose: OptionKey<T[I], I>;
        readonly plan: PlanOf<T[I]>;
      };
    }[IndexOf<T>]
  : N extends Branch<infer P, infer TThen, infer TElse>
    ? BranchPlan<P, TThen, TElse>
  : N extends Parallel<infer T> ? { readonly [I in keyof T]: PlanOf<T[I]> }
  : never;

/**
 * What a node asks of the result before it: the parameter type of the
 * branch predicates that would be called with it. `unknown` for a node
 * without such a branch.
 */
export type Asks<N> = N extends Branch<infer P, infer _TThen, infer _TElse>
  ? Asked<P>
  : N extends Repeat<infer S> ? Asks<S>
  : N extends Sequence<infer T>
    ? T extends readonly [infer H, ...unknown[]] ? Asks<H> : unknown
  : N extends Choice<infer T> ? AsksAll<T>
  : N extends Parallel<infer T> ? AsksAll<T>
  : unknown;

/** What every node of a list asks of the result before it. */
export type AsksAll<T extends readonly unknown[]> = T extends
  readonly [infer H, ...infer R] ? Asks<H> & AsksAll<R> : unknown;

/**
 * The plan type of a node whose branch cannot be asked about the result
 * before it. No value has this type.
 */
export interface BranchMismatch<TAsked, TGiven> {
  /** What the predicate accepts. */
  readonly "a branch predicate asks about": TAsked;
  /** What it would be called with. */
  readonly "but the result before it is": TGiven;
  /** Makes the type uninhabited. */
  readonly "no plan exists": never;
}

/**
 * The plan of a sequence: the plan of its first element, and a
 * continuation that receives that element's result and returns the plan
 * of the rest. A sequence of one element is that element's plan.
 *
 * The continuation is where a later request uses an earlier response:
 * the dependency is a closure.
 */
export type SequencePlan<T extends readonly unknown[]> = T extends readonly []
  ? undefined
  : T extends readonly [infer H] ? PlanOf<H>
  : T extends readonly [infer H, ...infer R]
    ? [ResultOf<H>] extends [AsksAll<FirstOf<R>>] ? {
        /** The plan of the first element. */
        readonly first: PlanOf<H>;
        /** From the first element's result to the plan of the rest. */
        readonly rest: (
          result: ResultOf<H>,
        ) => SequencePlan<R> | Promise<SequencePlan<R>>;
      }
    : BranchMismatch<AsksAll<FirstOf<R>>, ResultOf<H>>
  : never;

/** The first element of a list, as a list. */
export type FirstOf<T extends readonly unknown[]> = T extends
  readonly [infer H, ...unknown[]] ? [H] : [];

/**
 * The plan of a repetition: `undefined` to stop, or the plan of one run
 * and a continuation that receives its result and decides what follows.
 */
export type RepeatPlan<S> = undefined | {
  /** The plan of the next run. */
  readonly next: PlanOf<S>;
  /** From that run's result to the plan of the remaining runs. */
  readonly rest: (
    result: ResultOf<S>,
  ) => RepeatPlan<S> | Promise<RepeatPlan<S>>;
};

/** What `each()` returns: a repeat plan that ignores the results. */
export type EachPlan<TPlan> = undefined | {
  /** The plan of the next run. */
  readonly next: TPlan;
  /** The plan of the remaining runs. */
  readonly rest: () => EachPlan<TPlan>;
};

/** The type a predicate is asked about. */
export type Asked<P> = P extends (prev: infer T) => boolean ? T : never;

/** The type a predicate narrows to; the asked type if it is no guard. */
export type Narrowed<P> =
  // deno-lint-ignore no-explicit-any
  P extends (prev: any) => prev is infer T ? T : Asked<P>;

/**
 * The plan of a branch: a plan for each side, as a function of the value
 * the predicate was asked about. When the predicate is a type guard, the
 * `then` side (`ifTrue`) receives the narrowed type and the `else` side
 * (`ifFalse`) what remains.
 */
export interface BranchPlan<P, TThen, TElse> {
  /** The plan of the `then` side: the predicate holds. */
  readonly ifTrue: (
    prev: Narrowed<P>,
  ) => PlanOf<TThen> | Promise<PlanOf<TThen>>;
  /** The plan of the `else` side: it does not. */
  readonly ifFalse: (
    prev: Exclude<Asked<P>, Narrowed<P>>,
  ) => PlanOf<TElse> | Promise<PlanOf<TElse>>;
}

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
  /** The result before this node in its sequence: what a branch is asked. */
  previous: unknown,
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
          i === 0 ? previous : results[i - 1],
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
        const result = await runNode(step, current.next, run, here, previous);
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
        previous,
      );
      return { choice: choose, result };
    }

    case "branch": {
      const branchNode = node as Branch;
      const sides = shape(plan, ["ifTrue", "ifFalse"], run, at);
      const holds = (branchNode.predicate as (prev: unknown) => boolean)(
        previous,
      ) === true;
      const key = holds ? "ifTrue" : "ifFalse";
      const side = holds ? "then" : "else";
      const planOf = sides[key];
      if (typeof planOf !== "function") {
        throw new PlanError(`\`${key}\` is not a function`, run.name, at);
      }
      const result = await runNode(
        branchNode[side],
        await planOf(previous),
        run,
        `${at}.${side}`,
        previous,
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
        steps.map((step, i) =>
          runNode(step, plan[i], arms[i], `${at}[${i}]`, previous)
        ),
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
 * That a dependent step's dependency ran earlier in the plan is checked at
 * run time (`StepNotAvailableError`), not by `PlanOf`.
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
  plan: [undefined] extends [Asks<N>] ? PlanOf<N>
    : BranchMismatch<Asks<N>, undefined>,
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
  return await runNode(node, plan, run, at, undefined) as ResultOf<N>;
}

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
  Protocol,
  Step,
  StepResponse,
} from "./types.ts";

// =============================================================================
// Type Utilities
// =============================================================================

/** Check if step is independent (no dependencies) - checks __kind directly */
type IsIndependent<T> = T extends { __kind: "step" } ? true : false;

/** Get the dependency of a dependent step - accesses property directly */
type DependencyOf<T> = T extends { __kind: "dependent_step"; dependsOn: string }
  ? T["dependsOn"]
  : never;

/** Steps available when state has certain completed steps */
export type AvailableSteps<
  TSteps extends Record<string, AnyStep>,
  TDone extends string,
> = {
  [K in keyof TSteps & string]: IsIndependent<TSteps[K]> extends true ? K
    : DependencyOf<TSteps[K]> extends TDone ? K
    : never;
}[keyof TSteps & string];

// =============================================================================
// Executor Interface
// =============================================================================

export interface StepExecutor {
  // deno-lint-ignore no-explicit-any
  execute(step: string, request: unknown, ctx: ExecutionContext): Promise<any>;
}

export interface ExecutionContext {
  protocol: string;
  history: string[];
  responses: Record<string, unknown>;
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
> = {
  [K in TDone]: StepResponse<TSteps[K]>;
};

/**
 * Execute result - contains response and updated session.
 */
export interface ExecuteResult<
  TResponse,
  TSteps extends Record<string, AnyStep>,
  TNewDone extends keyof TSteps,
> {
  response: TResponse;
  session: ProtocolSession<TSteps, TNewDone>;
}

// =============================================================================
// Protocol Session Class
// =============================================================================

/**
 * Protocol session - generic over steps and completed step names.
 *
 * TDone is a union of step names that have been executed.
 * This grows as steps complete, enabling type-safe dependency tracking.
 *
 * Each method that executes a step returns a NEW session with updated TDone type.
 */
export class ProtocolSession<
  TSteps extends Record<string, AnyStep>,
  TDone extends keyof TSteps = never,
> {
  readonly __tag = "ProtocolSession" as const;

  constructor(
    readonly protocol: {
      readonly __kind: "protocol";
      readonly name: string;
      readonly steps: TSteps;
      readonly terminal?: readonly (string | keyof TSteps)[];
    },
    readonly executor: StepExecutor,
    readonly responses: SessionState<TSteps, TDone>,
    readonly history: readonly string[],
  ) {}

  /**
   * Execute a step.
   *
   * Only steps that are currently available can be executed:
   * - Independent steps (no dependencies) are always available
   * - Dependent steps are available after their dependency is completed
   */
  async execute<K extends string & AvailableSteps<TSteps, TDone & string>>(
    stepName: K,
    request: TSteps[K] extends Step<string, infer R, z.ZodType> ? z.infer<R>
      : unknown,
  ): Promise<ExecuteResult<StepResponse<TSteps[K]>, TSteps, TDone | K>> {
    const step = this.protocol.steps[stepName];

    if (!step) {
      throw new Error(`Unknown step: ${stepName}`);
    }

    // Get request schema
    let requestSchema: z.ZodType;
    if (step.__kind === "step") {
      requestSchema = step.request;
    } else {
      // Dependent step - get previous response and derive schema
      const depStep = step as DependentStep;
      const prevResponse = this.responses[
        depStep.dependsOn as keyof typeof this.responses
      ];
      if (prevResponse === undefined) {
        throw new Error(
          `Cannot execute "${stepName}": dependency "${depStep.dependsOn}" not satisfied`,
        );
      }
      requestSchema = depStep.request(prevResponse);
    }

    // Validate request
    const reqResult = requestSchema.safeParse(request);
    if (!reqResult.success) {
      throw new Error(
        `Invalid request for "${stepName}": ${reqResult.error.message}`,
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
      throw new Error(
        `Invalid response from "${stepName}": ${resResult.error.message}`,
      );
    }

    // Create new session with updated state
    const newResponses = {
      ...this.responses,
      [stepName]: resResult.data,
    } as SessionState<TSteps, TDone | K>;

    const newSession = new ProtocolSession<TSteps, TDone | K>(
      this.protocol,
      this.executor,
      newResponses,
      [...this.history, stepName],
    );

    return {
      response: resResult.data as StepResponse<TSteps[K]>,
      session: newSession,
    };
  }

  /** Check if a step can be executed (runtime check) */
  canExecute(stepName: string): boolean {
    const step = this.protocol.steps[stepName];
    if (!step) return false;
    if (step.__kind === "step") return true;
    const depStep = step as DependentStep;
    return depStep.dependsOn in this.responses;
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
}

// =============================================================================
// Session Creation
// =============================================================================

/**
 * Create initial session - no steps executed yet.
 */
export function createSession<TSteps extends Record<string, AnyStep>>(
  protocol: Protocol<string, TSteps>,
  executor: StepExecutor,
): ProtocolSession<TSteps, never> {
  return new ProtocolSession<TSteps, never>(
    protocol as {
      readonly __kind: "protocol";
      readonly name: string;
      readonly steps: TSteps;
      readonly terminal?: readonly (string | keyof TSteps)[];
    },
    executor,
    {} as SessionState<TSteps, never>,
    [],
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

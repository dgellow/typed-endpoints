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
  StepResponse,
} from "./types.ts";
import { zodType } from "../core/zod_internals.ts";
import { validateProtocol } from "./dsl.ts";
import {
  InvalidRequestError,
  InvalidResponseError,
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
type IsIndependent<T> = T extends { __kind: "step" } ? true
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
type MappingSources<T> = T extends { requestMapping: infer M } ? {
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
type DependencyOf<T> = T extends { __kind: "dependent_step"; dependsOn: string }
  ? T["dependsOn"]
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
 * Values forwarded from earlier steps are typed by their base type here
 * (`code: string`); that they equal the earlier value is checked at runtime.
 */
export type StepInput<T> = T extends
  { __kind: "step"; request: infer R extends z.ZodType } ? z.input<R>
  : T extends
    { __kind: "mapped_step"; requestSchema: infer R extends z.ZodType }
    ? z.input<R>
  : T extends {
    __kind: "dependent_step";
    request: (prev: never) => infer R extends z.ZodType;
  } ? z.input<R>
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

function isNeverSchema(schema: z.ZodType): boolean {
  return zodType(schema) === "never";
}

// =============================================================================
// Executor Interface
// =============================================================================

export interface StepExecutor {
  // deno-lint-ignore no-explicit-any
  execute(step: string, request: unknown, ctx: ExecutionContext): Promise<any>;
}

export interface ExecutionContext {
  readonly protocol: string;
  readonly history: string[];
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
  readonly response: TResponse;
  readonly session: ProtocolSession<TSteps, TNewDone>;
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
    request: StepInput<TSteps[K]>,
  ): Promise<ExecuteResult<StepResponse<TSteps[K]>, TSteps, TDone | K>> {
    const step = this.protocol.steps[stepName];

    const protocolName = this.protocol.name;

    if (!step) {
      throw new UnknownStepError(protocolName, stepName);
    }

    // Get request schema
    let requestSchema: z.ZodType;
    if (step.__kind === "step") {
      requestSchema = step.request;
    } else if (step.__kind === "mapped_step") {
      // Mapped step - derive schema with literal replacements
      const mappedStep = step as MappedStep;
      if (!(mappedStep.dependsOn in this.responses)) {
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
        const sourceResponse = this.responses[
          mapping.step as keyof typeof this.responses
        ];
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
      const prevResponse = this.responses[
        depStep.dependsOn as keyof typeof this.responses
      ];
      if (prevResponse === undefined) {
        throw new StepNotAvailableError(
          `Cannot execute "${stepName}": dependency "${depStep.dependsOn}" not satisfied`,
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

    // Validate request
    const reqResult = requestSchema.safeParse(request);
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
    if (step.__kind === "mapped_step") {
      const mappedStep = step as MappedStep;
      // Check primary dependency
      if (!(mappedStep.dependsOn in this.responses)) return false;
      // Check all mapping source steps have responses
      for (const mapping of Object.values(mappedStep.requestMapping)) {
        if (isFieldMapping(mapping) && !(mapping.step in this.responses)) {
          return false;
        }
      }
      return true;
    }
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

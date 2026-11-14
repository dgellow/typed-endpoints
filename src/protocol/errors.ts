/**
 * Errors raised by a protocol session.
 *
 * Each failure mode of `ProtocolSession.execute()` has its own class, so a
 * caller can tell them apart without matching on message text:
 *
 * | Class | Meaning | Who is at fault |
 * | -- | -- | -- |
 * | `UnknownStepError` | the protocol has no such step | caller |
 * | `StepNotAvailableError` | a step it depends on has not run | caller |
 * | `StepRefusedError` | the steps it depends on ran, but what they returned does not allow it | neither: the flow ended there |
 * | `InvalidRequestError` | the request does not match the step's schema | caller |
 * | `InvalidResponseError` | the response does not match the step's schema | server |
 *
 * Errors thrown by the executor (for example `HttpError`) pass through
 * unchanged.
 *
 * @module
 */

import type { z } from "zod";

/** Validation issues, as Zod reports them. */
export type ValidationIssues = z.ZodError["issues"];

/** Base class of the errors a protocol session raises. */
export class ProtocolError extends Error {
  /**
   * Create the error.
   *
   * @param message Error message.
   * @param protocol Name of the protocol.
   * @param step Name of the step that was being executed.
   */
  constructor(
    message: string,
    /** Name of the protocol. */
    readonly protocol: string,
    /** Name of the step that was being executed. */
    readonly step: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** The protocol has no step of that name. */
export class UnknownStepError extends ProtocolError {
  /**
   * Create the error.
   *
   * @param protocol Name of the protocol.
   * @param step The step name that was asked for.
   */
  constructor(protocol: string, step: string) {
    super(`Unknown step: ${step}`, protocol, step);
  }
}

/** A step this one depends on has not been executed yet. */
export class StepNotAvailableError extends ProtocolError {
  /**
   * Create the error.
   *
   * @param message Error message.
   * @param protocol Name of the protocol.
   * @param step Name of the step that was being executed.
   * @param requires The step that has to run first.
   */
  constructor(
    message: string,
    protocol: string,
    step: string,
    /** The step that has to run first. */
    readonly requires: string,
  ) {
    super(message, protocol, step);
  }
}

/**
 * The steps this one depends on have run, but their responses do not allow
 * it: a dependent step answered the previous response with `z.never()`, or
 * a mapped field has no value in the response it is mapped from.
 *
 * Typical case: `exchange` after `authorize` returned its error variant.
 */
export class StepRefusedError extends ProtocolError {
  /**
   * Create the error.
   *
   * @param message Error message.
   * @param protocol Name of the protocol.
   * @param step Name of the step that was being executed.
   * @param because The step whose response rules this one out.
   */
  constructor(
    message: string,
    protocol: string,
    step: string,
    /** The step whose response rules this one out. */
    readonly because: string,
  ) {
    super(message, protocol, step);
  }
}

/** The request does not match the step's request schema. */
export class InvalidRequestError extends ProtocolError {
  /**
   * Create the error.
   *
   * @param message Error message.
   * @param protocol Name of the protocol.
   * @param step Name of the step that was being executed.
   * @param issues What the request schema rejected.
   */
  constructor(
    message: string,
    protocol: string,
    step: string,
    readonly issues: ValidationIssues,
  ) {
    super(message, protocol, step);
  }
}

/** The executor returned something that is not the step's response. */
export class InvalidResponseError extends ProtocolError {
  /**
   * Create the error.
   *
   * @param message Error message.
   * @param protocol Name of the protocol.
   * @param step Name of the step that was being executed.
   * @param issues What the response schema rejected.
   */
  constructor(
    message: string,
    protocol: string,
    step: string,
    readonly issues: ValidationIssues,
  ) {
    super(message, protocol, step);
  }
}

/**
 * The session value was already used to execute a step.
 *
 * Raised by a session created with `singleUse`: each session value can
 * continue the protocol once. Continue with the session `execute()`
 * returned.
 */
export class SessionSpentError extends ProtocolError {
  /**
   * Create the error.
   *
   * @param protocol Name of the protocol.
   * @param step Name of the step that was being executed.
   * @param spentBy The step this session value was used for before.
   */
  constructor(
    protocol: string,
    step: string,
    /** The step this session value was used for before. */
    readonly spentBy: string,
  ) {
    super(
      `Cannot execute "${step}": this session value was already used to execute "${spentBy}"; continue with the session that call returned`,
      protocol,
      step,
    );
  }
}

/**
 * The session was ended (`await using`, `session.abandon()`), and a step
 * was executed on it afterwards.
 */
export class SessionEndedError extends ProtocolError {
  /**
   * Create the error.
   *
   * @param protocol Name of the protocol.
   * @param step Name of the step that was being executed.
   */
  constructor(protocol: string, step: string) {
    super(
      `Cannot execute "${step}": the session was ended`,
      protocol,
      step,
    );
  }
}

/**
 * A session created with `linear` was ended before a terminal step.
 *
 * Raised after the protocol's `onAbandon` step has run, if it could.
 */
export class SessionAbandonedError extends ProtocolError {
  /**
   * Create the error.
   *
   * @param protocol Name of the protocol.
   * @param history Names of the steps the session executed, in order.
   * @param released Name of the `onAbandon` step, if it ran.
   */
  constructor(
    protocol: string,
    /** Names of the steps the session executed, in order. */
    readonly history: readonly string[],
    /** Name of the `onAbandon` step, if it ran. */
    readonly released: string | undefined,
  ) {
    super(
      `Session ended after "${
        history.at(-1)
      }", which is not a terminal step of "${protocol}"${
        released === undefined ? "" : ` ("${released}" was run)`
      }`,
      protocol,
      history.at(-1) ?? "",
    );
  }
}

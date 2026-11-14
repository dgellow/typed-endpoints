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
  constructor(protocol: string, step: string) {
    super(`Unknown step: ${step}`, protocol, step);
  }
}

/** A step this one depends on has not been executed yet. */
export class StepNotAvailableError extends ProtocolError {
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
  constructor(
    message: string,
    protocol: string,
    step: string,
    readonly issues: ValidationIssues,
  ) {
    super(message, protocol, step);
  }
}

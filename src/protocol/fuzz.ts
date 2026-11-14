/**
 * Protocol fuzzing: the calls the types forbid, sent to a server.
 *
 * A session stops a client from calling `exchange` before `authorize`, or
 * from spending an authorization code twice. That says nothing about the
 * server: whether it refuses those calls when a client that does not use
 * the types sends them.
 *
 * `fuzzProtocol()` walks a protocol the way a session allows, with
 * generated requests, and at every state it reaches it also sends the
 * calls the protocol forbids there, past the session, straight to the
 * executor:
 *
 * - `before-dependency`: a step whose dependency has not run
 * - `wrong-variant`: a step whose `when` condition the earlier response
 *   does not meet, or whose forwarded field has no value
 * - `revoked`: a step whose dependency was revoked; where the step ran
 *   before, the request it sent then is sent again (a replay)
 * - `forged`: an available step, with a request built for another earlier
 *   response than the one the server gave
 *
 * A forbidden call the server answers as if it were allowed is a finding.
 * Whether it is a defect is for the protocol's author to say: for a
 * credential it is, for a stateless lookup it may be the protocol that is
 * stricter than the server needs.
 *
 * The walk is driven by a seeded generator: a report names the seed and
 * each finding carries the calls that led to it.
 *
 * @module
 */

import type { z } from "zod";

import {
  arbitrary,
  ArbitraryError,
  type Random,
  seededRandom,
} from "../core/arbitrary.ts";
import { zodType } from "../core/zod_internals.ts";
import {
  type ExecutionContext,
  requestSchemaOf,
  responsesAfter,
  type StepExecutor,
} from "./client.ts";
import { StepNotAvailableError, StepRefusedError } from "./errors.ts";
import { type FieldMapping, getNestedValue } from "./mapping.ts";
import type { AnyStep, Protocol } from "./types.ts";

// =============================================================================
// Types
// =============================================================================

/** Why the protocol forbids a call. */
export type ForbiddenReason =
  | "before-dependency"
  | "wrong-variant"
  | "revoked"
  | "forged";

/** Every reason, in the order they are reported. */
export const FORBIDDEN_REASONS: readonly ForbiddenReason[] = [
  "before-dependency",
  "wrong-variant",
  "revoked",
  "forged",
];

/** A call the walk made and the server accepted. */
export interface FuzzCall {
  /** Name of the step. */
  readonly step: string;
  /** The request that was sent. */
  readonly request: unknown;
  /** The response, parsed by the step's schema. */
  readonly response: unknown;
}

/** Something a fuzz run found. */
export type FuzzFinding =
  | {
    /** The server accepted a call the protocol forbids. */
    readonly kind: "forbidden-accepted";
    /** Why the call is forbidden. */
    readonly reason: ForbiddenReason;
    /** Whether the request is one the server accepted earlier, sent again. */
    readonly replay: boolean;
    /** Index of the walk. */
    readonly run: number;
    /** Name of the step. */
    readonly step: string;
    /** The request that was sent. */
    readonly request: unknown;
    /** What the server answered. */
    readonly response: unknown;
    /** The accepted calls before it, in order. */
    readonly history: readonly FuzzCall[];
  }
  | {
    /** The server refused a call the protocol allows. */
    readonly kind: "allowed-refused";
    /** Index of the walk. */
    readonly run: number;
    /** Name of the step. */
    readonly step: string;
    /** The request that was sent. */
    readonly request: unknown;
    /** What the executor threw. */
    readonly error: unknown;
    /** The accepted calls before it, in order. */
    readonly history: readonly FuzzCall[];
  }
  | {
    /** The server's answer to an allowed call does not fit the schema. */
    readonly kind: "invalid-response";
    /** Index of the walk. */
    readonly run: number;
    /** Name of the step. */
    readonly step: string;
    /** The request that was sent. */
    readonly request: unknown;
    /** What the server answered. */
    readonly response: unknown;
    /** The schema's first complaint. */
    readonly issue: string;
    /** The accepted calls before it, in order. */
    readonly history: readonly FuzzCall[];
  };

/** Counts of the forbidden calls of one reason. */
export interface ProbeCount {
  /** Calls sent. */
  readonly sent: number;
  /** Calls the server refused. */
  readonly refused: number;
}

/** What a fuzz run did and found. */
export interface FuzzReport {
  /** The seed the run was driven by. */
  readonly seed: number;
  /** Number of walks. */
  readonly runs: number;
  /** Allowed calls: sent, and accepted with a response the schema accepts. */
  readonly allowed: { readonly sent: number; readonly accepted: number };
  /** Forbidden calls, by reason. */
  readonly forbidden: Readonly<Record<ForbiddenReason, ProbeCount>>;
  /**
   * Calls that were not sent because no request could be generated, by
   * step name. A step listed here needs an entry in `requests`.
   */
  readonly skipped: Readonly<Record<string, number>>;
  /**
   * Allowed calls the server answered with a response `isRefusal` calls a
   * refusal, by step name. These are not findings: a user may deny an
   * authorization. A step listed here that should always succeed says the
   * protocol does not follow the server, for instance a refresh token
   * that rotates while the protocol keeps sending the first one.
   */
  readonly declined: Readonly<Record<string, number>>;
  /** Steps the server accepted at least once. */
  readonly covered: readonly string[];
  /** What was found, in the order it happened. */
  readonly findings: readonly FuzzFinding[];
}

/** What a request generator is given. */
export interface RequestContext {
  /** The request schema of the step in the current state. */
  readonly schema: z.ZodType;
  /** The run's generator. */
  readonly random: Random;
  /** The latest response of each step that ran, by step name. */
  readonly responses: Readonly<Record<string, unknown>>;
}

/** Options of `fuzzProtocol()`. */
export interface FuzzOptions<TSteps> {
  /** Seed of the run. Default: 0. */
  readonly seed?: number;
  /** Number of walks, each from a fresh state. Default: 20. */
  readonly runs?: number;
  /** Allowed calls per walk. Default: three times the number of steps. */
  readonly maxSteps?: number;
  /**
   * Which forbidden calls to send: a list of reasons, or a function of the
   * step and the reason. Default: all of them.
   *
   * Leave out a step the server answers the same way in every state. Token
   * revocation is one (RFC 7009, section 2.2: the answer is 200 for a
   * token the server does not know).
   */
  readonly probes?:
    | readonly ForbiddenReason[]
    | ((step: string, reason: ForbiddenReason) => boolean);
  /**
   * Whether a response refuses the call, for a server that answers a
   * refusal with a response of its own (an error variant) and not with an
   * error. Default: only an error the executor throws is a refusal.
   */
  readonly isRefusal?: (step: string, response: unknown) => boolean;
  /**
   * Requests for the allowed calls of a step, where a generated value is
   * not good enough: real credentials, an id that exists. Default:
   * `arbitrary(schema)`.
   */
  readonly requests?: {
    readonly [K in keyof TSteps]?: (context: RequestContext) => unknown;
  };
}

// =============================================================================
// Fuzzer
// =============================================================================

/** The state of one walk. */
interface Walk {
  responses: Record<string, unknown>;
  readonly calls: FuzzCall[];
  /**
   * The last request the server accepted, by step, with the response of
   * the step's dependency it was made for.
   */
  readonly accepted: Map<string, { request: unknown; basis: unknown }>;
  /** Responses that were revoked. */
  readonly revoked: Set<unknown>;
  /**
   * For a response that renewed another (`renewing()`), the response it
   * took the place of. Revoking a response revokes what it renewed.
   */
  readonly renewedFrom: Map<unknown, unknown>;
  /** How often each probe was sent in this walk. */
  readonly probed: Map<string, number>;
}

/** Each probe is sent at most this often per walk. */
const PROBES_PER_WALK = 2;

type Classified =
  | { readonly allowed: true; readonly schema: z.ZodType }
  | { readonly allowed: false; readonly reason: ForbiddenReason };

/**
 * Walk a protocol with generated requests and send, at every state, the
 * calls it forbids there.
 *
 * @param protocol The protocol.
 * @param executor Performs the calls: an executor, or a function that
 * returns a fresh one for each walk (a server whose state starts over).
 * @param options Seed, size, and what counts as a refusal.
 */
export async function fuzzProtocol<TSteps extends Record<string, AnyStep>>(
  protocol: Protocol<string, TSteps>,
  executor: StepExecutor | (() => StepExecutor | Promise<StepExecutor>),
  options: FuzzOptions<TSteps> = {},
): Promise<FuzzReport> {
  const seed = options.seed ?? 0;
  const runs = options.runs ?? 20;
  const steps = Object.entries(protocol.steps) as [string, AnyStep][];
  const maxSteps = options.maxSteps ?? steps.length * 3;
  const wanted = options.probes ?? FORBIDDEN_REASONS;
  const probes = typeof wanted === "function"
    ? wanted
    : (_step: string, reason: ForbiddenReason) => wanted.includes(reason);
  const terminal = new Set((protocol.terminal ?? []) as string[]);
  const random = seededRandom(seed);
  const everAccepted = new Set<string>();

  const allowed = { sent: 0, accepted: 0 };
  const forbidden = Object.fromEntries(
    FORBIDDEN_REASONS.map((reason) => [reason, { sent: 0, refused: 0 }]),
  ) as Record<ForbiddenReason, { sent: number; refused: number }>;
  const skipped: Record<string, number> = {};
  const declined: Record<string, number> = {};
  const findings: FuzzFinding[] = [];

  const skip = (name: string) => {
    skipped[name] = (skipped[name] ?? 0) + 1;
  };

  const classify = (name: string, step: AnyStep, walk: Walk): Classified => {
    try {
      return {
        allowed: true,
        schema: requestSchemaOf(protocol.name, name, step, walk.responses),
      };
    } catch (error) {
      if (error instanceof StepNotAvailableError) {
        const ranBefore = walk.calls.some((call) =>
          call.step === error.requires
        );
        return {
          allowed: false,
          reason: ranBefore ? "revoked" : "before-dependency",
        };
      }
      if (error instanceof StepRefusedError) {
        return { allowed: false, reason: "wrong-variant" };
      }
      throw error;
    }
  };

  /**
   * A request the protocol allows in the current state. For a mapped step
   * the forwarded fields are copied from the responses they are mapped to:
   * no generator would hit those values.
   */
  const generate = (step: AnyStep, schema: z.ZodType, walk: Walk): unknown => {
    if (step.__kind !== "mapped_step") return arbitrary(schema, { random });
    const request = arbitrary(step.requestSchema, { random }) as Record<
      string,
      unknown
    >;
    const mappings = step.requestMapping as Record<string, FieldMapping>;
    for (const [field, mapping] of Object.entries(mappings)) {
      request[field] = getNestedValue(
        walk.responses[mapping.step],
        mapping.path,
      );
    }
    return request;
  };

  /**
   * A request for a step as if its dependency had answered something
   * else: a response of the dependency is made up, and the request is
   * generated for it.
   */
  const fabricate = (step: AnyStep): unknown => {
    if (step.__kind === "mapped_step") {
      return arbitrary(step.requestSchema, { random });
    }
    if (step.__kind === "step") return arbitrary(step.request, { random });

    const dependency = protocol.steps[step.dependsOn] as AnyStep | undefined;
    if (!dependency) {
      throw new ArbitraryError(`no step "${step.dependsOn}"`, step.name);
    }
    for (let attempt = 0; attempt < 50; attempt++) {
      const prev = dependency.response.parse(
        arbitrary(dependency.response, { random }),
      );
      if (step.when && !step.when(prev)) continue;
      const schema = step.request(prev);
      if (zodType(schema) === "never") continue;
      return arbitrary(schema, { random });
    }
    throw new ArbitraryError(
      `no response of "${step.dependsOn}" that "${step.name}" can follow`,
      step.name,
    );
  };

  for (let run = 0; run < runs; run++) {
    const target = typeof executor === "function" ? await executor() : executor;
    const walk: Walk = {
      responses: {},
      calls: [],
      accepted: new Map(),
      revoked: new Set(),
      renewedFrom: new Map(),
      probed: new Map(),
    };
    const context = (): ExecutionContext => ({
      protocol: protocol.name,
      history: walk.calls.map((call) => call.step),
      responses: { ...walk.responses },
    });

    /** Send a call the protocol forbids; record it if it is accepted. */
    const probe = async (
      name: string,
      step: AnyStep,
      reason: ForbiddenReason,
      accepts?: z.ZodType,
    ): Promise<void> => {
      if (!probes(name, reason)) return;
      const key = `${name}:${reason}`;
      const count = walk.probed.get(key) ?? 0;
      if (count >= PROBES_PER_WALK) return;

      // A request the server accepted before is the sharpest probe of a
      // step that is no longer available: a replay. Only a request made
      // for a response that has since been revoked qualifies; one made for
      // a response that was merely superseded (a second login) may still
      // be good, and the server is right to accept it.
      const earlier = walk.accepted.get(name);
      const replay = reason !== "forged" && earlier !== undefined &&
        walk.revoked.has(earlier.basis);
      let request: unknown;
      if (replay) {
        request = earlier.request;
      } else {
        try {
          request = fabricate(step);
        } catch (error) {
          if (!(error instanceof ArbitraryError)) throw error;
          skip(name);
          return;
        }
      }
      // A made-up request that happens to be the right one is not forged.
      if (accepts?.safeParse(request).success) return;

      walk.probed.set(key, count + 1);
      forbidden[reason].sent++;
      let response: unknown;
      try {
        response = await target.execute(name, request, context());
      } catch {
        forbidden[reason].refused++;
        return;
      }
      if (options.isRefusal?.(name, response)) {
        forbidden[reason].refused++;
        return;
      }
      findings.push({
        kind: "forbidden-accepted",
        reason,
        replay,
        run,
        step: name,
        request,
        response,
        history: [...walk.calls],
      });
    };

    for (let i = 0; i < maxSteps; i++) {
      const available: [string, AnyStep, z.ZodType][] = [];
      for (const [name, step] of steps) {
        const state = classify(name, step, walk);
        if (!state.allowed) {
          await probe(name, step, state.reason);
        } else {
          if (step.__kind !== "step") {
            await probe(name, step, "forged", state.schema);
          }
          available.push([name, step, state.schema]);
        }
      }
      if (available.length === 0) break;

      // Prefer a step this walk has not made yet.
      const fresh = available.filter(([name]) =>
        !walk.calls.some((call) => call.step === name)
      );
      const pool = fresh.length > 0 && random() < 0.7 ? fresh : available;
      const [name, step, schema] = pool[Math.floor(random() * pool.length)];

      let request: unknown;
      try {
        const custom = options.requests?.[name as keyof TSteps];
        request = custom
          ? custom({ schema, random, responses: { ...walk.responses } })
          : generate(step, schema, walk);
      } catch (error) {
        if (!(error instanceof ArbitraryError)) throw error;
        skip(name);
        continue;
      }

      const basis = step.__kind === "step"
        ? undefined
        : walk.responses[step.dependsOn];
      allowed.sent++;
      let response: unknown;
      try {
        response = await target.execute(name, request, context());
      } catch (error) {
        findings.push({
          kind: "allowed-refused",
          run,
          step: name,
          request,
          error,
          history: [...walk.calls],
        });
        continue;
      }
      const parsed = step.response.safeParse(response);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        findings.push({
          kind: "invalid-response",
          run,
          step: name,
          request,
          response,
          issue: `${issue.path.join(".")}: ${issue.message}`,
          history: [...walk.calls],
        });
        continue;
      }

      allowed.accepted++;
      everAccepted.add(name);
      if (options.isRefusal?.(name, parsed.data)) {
        declined[name] = (declined[name] ?? 0) + 1;
      }
      walk.accepted.set(name, { request, basis });
      walk.calls.push({ step: name, request, response: parsed.data });
      const before = walk.responses;
      walk.responses = responsesAfter(
        protocol.name,
        name,
        step,
        before,
        parsed.data,
      );
      for (const [other, earlier] of Object.entries(before)) {
        const now = walk.responses[other];
        if (other === name || now === earlier) continue;
        if (other in walk.responses) {
          // Renewed: the new response stands in for the earlier one.
          walk.renewedFrom.set(now, earlier);
        } else {
          // Revoked, and with it every response it had renewed.
          let gone: unknown = earlier;
          while (gone !== undefined && !walk.revoked.has(gone)) {
            walk.revoked.add(gone);
            gone = walk.renewedFrom.get(gone);
          }
        }
      }
      if (terminal.has(name)) break;
    }

    // What the walk leaves forbidden is probed once more: after a terminal
    // step, nothing above looks at the state again.
    for (const [name, step] of steps) {
      const state = classify(name, step, walk);
      if (!state.allowed) await probe(name, step, state.reason);
    }
  }

  return {
    seed,
    runs,
    allowed,
    forbidden,
    skipped,
    declined,
    covered: steps.map(([name]) => name).filter((name) =>
      everAccepted.has(name)
    ),
    findings,
  };
}

/**
 * A fuzz report as text: the counts, then each kind of finding once with
 * the calls that led to its first occurrence.
 */
export function formatFuzzReport(report: FuzzReport): string {
  const lines = [
    `seed ${report.seed}, ${report.runs} walks`,
    `allowed calls: ${report.allowed.accepted}/${report.allowed.sent} accepted`,
    ...FORBIDDEN_REASONS.map((reason) => {
      const { sent, refused } = report.forbidden[reason];
      return `forbidden (${reason}): ${refused}/${sent} refused`;
    }),
    `covered: ${report.covered.join(", ") || "nothing"}`,
  ];
  const declined = Object.entries(report.declined);
  if (declined.length > 0) {
    lines.push(
      `allowed calls answered with a refusal: ${
        declined.map(([s, n]) => `${s} (${n})`).join(", ")
      }`,
    );
  }
  const skipped = Object.entries(report.skipped);
  if (skipped.length > 0) {
    lines.push(
      `not generated: ${skipped.map(([s, n]) => `${s} (${n})`).join(", ")}`,
    );
  }

  const seen = new Set<string>();
  for (const finding of report.findings) {
    const key = finding.kind === "forbidden-accepted"
      ? `${finding.kind}:${finding.step}:${finding.reason}:${finding.replay}`
      : `${finding.kind}:${finding.step}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const count = report.findings.filter((other) =>
      other.kind === finding.kind && other.step === finding.step &&
      (other.kind !== "forbidden-accepted" ||
        finding.kind !== "forbidden-accepted" ||
        (other.reason === finding.reason && other.replay === finding.replay))
    ).length;

    const what = finding.kind === "forbidden-accepted"
      ? `the server accepted "${finding.step}" (${finding.reason}${
        finding.replay ? ", replayed request" : ""
      })`
      : finding.kind === "allowed-refused"
      ? `the server refused "${finding.step}", which the protocol allows`
      : `the response of "${finding.step}" does not fit its schema: ${finding.issue}`;
    lines.push("", `${what}, ${count} time${count === 1 ? "" : "s"}`);
    lines.push(`  walk ${finding.run}, after: ${
      finding.history.map((call) => call.step).join(" > ") || "nothing"
    }`);
    lines.push(`  request: ${JSON.stringify(finding.request)}`);
    if (finding.kind !== "allowed-refused") {
      lines.push(`  response: ${JSON.stringify(finding.response)}`);
    } else {
      lines.push(`  error: ${String(finding.error)}`);
    }
  }
  return lines.join("\n");
}

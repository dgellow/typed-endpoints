/**
 * Lens laws for a resource, checked against a server.
 *
 * A route with GET and PUT on one path is a lens: GET is the view of some
 * state the server keeps, PUT updates that state from a value. A lens is
 * expected to obey laws, and each of them is a statement about HTTP that a
 * client relies on without saying so:
 *
 * - `get-get`: GET twice gives the same view. GET is safe (RFC 9110,
 *   9.2.1). The other laws compare views, so they mean nothing without it
 * - `put-get` (PutGet): PUT `v`, then GET: the view has what was put
 * - `get-put` (GetPut): GET, PUT that view back, GET: nothing changed
 * - `put-put` (PutPut): PUT `w`, then PUT `u`, then PUT `w` again: the view
 *   is the one after the first PUT `w`. The last PUT wins and nothing of
 *   an earlier one remains: PUT replaces (RFC 9110, 9.3.4). Idempotence is
 *   the case `u = w`
 *
 * `checkResourceLaws()` sends those requests, with bodies generated from
 * the body schema, and reports where the views differ.
 *
 * The view (the GET response) is usually larger than the body: an id,
 * timestamps. `put-get` therefore asks that the view contains the body,
 * field by field, not that it equals it. The other laws compare whole
 * views; a field that changes on purpose (`updatedAt`, a revision
 * counter) is named in `ignore`.
 *
 * A PATCH with a partial body obeys `put-get` and `get-put` and not
 * `put-put` (fields of `u` that `w` does not mention remain), so `put-put`
 * is not checked for `method: "PATCH"` unless asked for.
 *
 * @module
 */

import type { z } from "zod";

import { arbitrary, type Random, seededRandom } from "./arbitrary.ts";
import { unwrapSchema, zodDef, zodType } from "./zod_internals.ts";

// =============================================================================
// Types
// =============================================================================

/** A law of a resource. */
export type ResourceLaw = "get-get" | "put-get" | "get-put" | "put-put";

/** Every law, in the order they are checked and reported. */
export const RESOURCE_LAWS: readonly ResourceLaw[] = [
  "get-get",
  "get-put",
  "put-get",
  "put-put",
];

/** The method that updates a resource. */
export type UpdateMethod = "PUT" | "PATCH";

/** The method definitions of a route, with or without its handlers. */
type DefOf<T> = T extends { readonly __apiDef: infer TDef } ? TDef : T;

/**
 * Why a route is not a resource. A route that is not one is asked to be
 * of this type, which nothing is, so the reason shows in the error.
 */
export interface NotAResource<TReason extends string> {
  readonly "not a resource": TReason;
}

/**
 * `unknown` when `T` is a resource updated with `TMethod`: it defines GET,
 * and `TMethod` with a body schema. `T` is the method definitions, or what
 * `createApiHandlers()` returns.
 */
export type Resource<T, TMethod extends UpdateMethod> = DefOf<T> extends
  infer TDef
  ? "GET" extends keyof TDef
    ? TMethod extends keyof TDef
      ? TDef[TMethod] extends { readonly body?: infer TBody }
        ? [TBody] extends [z.ZodType] ? unknown
        : NotAResource<`${TMethod} has no body schema`>
      : NotAResource<`${TMethod} has no body schema`>
    : NotAResource<`the route does not define ${TMethod}`>
  : NotAResource<"the route does not define GET">
  : never;

/** Options of `checkResourceLaws()`. */
export interface ResourceLawsOptions {
  /** URL of the resource, path parameters filled in. */
  readonly url: string | URL;
  /**
   * Sends a request. Default: `fetch`. A fetch handler called directly
   * checks the laws without a server.
   */
  readonly send?: (request: Request) => Response | Promise<Response>;
  /** How many times each law is checked, with new values. Default: 20. */
  readonly runs?: number;
  /** Seed of the generator. Default: 0. */
  readonly seed?: number;
  /**
   * The laws to check. Default: all four for PUT; all but `put-put` for
   * PATCH.
   */
  readonly laws?: readonly ResourceLaw[];
  /**
   * Places of the view the laws do not compare: dotted paths, `*` for any
   * key or index (`updatedAt`, `meta.revision`, `items.*.etag`).
   */
  readonly ignore?: readonly string[];
  /** Headers sent with every request. */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * The body of an update. Default: `arbitrary()` of the body schema. For
   * constraints the schema does not state (a foreign key, a unique name).
   */
  readonly value?: (random: Random) => unknown;
}

/** A request the check sent and what came back. */
export interface LawExchange {
  /** HTTP method. */
  readonly method: string;
  /** JSON body of the request, for an update. */
  readonly body?: unknown;
  /** Status of the response. */
  readonly status: number;
  /** Body of the response: parsed JSON, or the text when it is not JSON. */
  readonly response: unknown;
}

/** A place where two values differ. A missing member is absent here too. */
export interface LawDifference {
  /** Dotted path into the view; `""` is the view itself. */
  readonly path: string;
  /** What the law expects there. */
  readonly expected?: unknown;
  /** What the view has there. */
  readonly actual?: unknown;
}

/** A run in which a law did not hold. */
export interface LawViolation {
  /** Index of the run. */
  readonly run: number;
  /** The requests of this check, in order. */
  readonly exchanges: readonly LawExchange[];
  /** Where the views differ. */
  readonly differences: readonly LawDifference[];
}

/** A run in which the server refused a request, so nothing was compared. */
export interface LawRefusal {
  /** Index of the run. */
  readonly run: number;
  /** The requests of this check, in order; the last one was refused. */
  readonly exchanges: readonly LawExchange[];
}

/** A run in which a law could not be stated. */
export interface LawSkip {
  /** Index of the run. */
  readonly run: number;
  /** Why. */
  readonly reason: string;
}

/** What was found for one law. */
export interface LawResult {
  /** Runs in which the law held. */
  readonly held: number;
  /** Runs in which it did not. */
  readonly violations: readonly LawViolation[];
  /** Runs in which a request was answered with a status outside 200-299. */
  readonly refusals: readonly LawRefusal[];
  /**
   * Runs in which the law could not be stated: for `get-put`, the view is
   * not a value the body schema accepts.
   */
  readonly skips: readonly LawSkip[];
}

/** What `checkResourceLaws()` found. */
export interface ResourceLawsReport {
  /** URL of the resource. */
  readonly url: string;
  /** The update method. */
  readonly method: UpdateMethod;
  /** Seed of the generator. */
  readonly seed: number;
  /** Runs per law. */
  readonly runs: number;
  /** One result per law that was checked. */
  readonly laws: Readonly<Partial<Record<ResourceLaw, LawResult>>>;
  /**
   * Whether every checked law held in every run. A refusal or a skip is
   * not a run in which the law held.
   */
  readonly ok: boolean;
}

// =============================================================================
// Comparison
// =============================================================================

type Json = unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The value as JSON carries it. */
function asJson(value: unknown): Json {
  const text = JSON.stringify(value);
  return text === undefined ? undefined : JSON.parse(text);
}

function isIgnored(path: readonly string[], ignore: readonly string[][]) {
  return ignore.some((pattern) =>
    pattern.length === path.length &&
    pattern.every((part, i) => part === "*" || part === path[i])
  );
}

/**
 * Where `actual` differs from `expected`.
 *
 * With `contains`, an object in `actual` may have members `expected` does
 * not mention; lists still have to agree in length.
 */
function differences(
  expected: Json,
  actual: Json,
  contains: boolean,
  ignore: readonly string[][],
  path: readonly string[] = [],
  out: LawDifference[] = [],
): LawDifference[] {
  if (isIgnored(path, ignore)) return out;

  if (Array.isArray(expected) && Array.isArray(actual)) {
    const length = Math.max(expected.length, actual.length);
    for (let i = 0; i < length; i++) {
      member(String(i), i < expected.length, i < actual.length, [
        expected[i],
        actual[i],
      ]);
    }
    return out;
  }

  if (isRecord(expected) && isRecord(actual)) {
    const keys = new Set(Object.keys(expected));
    if (!contains) { for (const key of Object.keys(actual)) keys.add(key); }
    for (const key of [...keys].sort()) {
      member(key, key in expected, key in actual, [
        expected[key],
        actual[key],
      ]);
    }
    return out;
  }

  if (expected !== actual) {
    out.push({ path: path.join("."), expected, actual });
  }
  return out;

  function member(
    key: string,
    inExpected: boolean,
    inActual: boolean,
    [left, right]: readonly [Json, Json],
  ): void {
    const at = [...path, key];
    if (inExpected && inActual) {
      differences(left, right, contains, ignore, at, out);
    } else if (!isIgnored(at, ignore)) {
      out.push({
        path: at.join("."),
        ...(inExpected && { expected: left }),
        ...(inActual && { actual: right }),
      });
    }
  }
}

/**
 * The value without the object members the schema does not name. An object
 * schema that accepts other members (`z.looseObject()`, a catch-all) keeps
 * them.
 */
function project(schema: unknown, value: Json): Json {
  const def = zodDef(unwrapSchema(schema, "input"));

  if (def.type === "array" && Array.isArray(value)) {
    return value.map((item) => project(def.element, item));
  }

  if (def.type === "object" && isRecord(value)) {
    const shape = def.shape as Record<string, unknown>;
    const open = def.catchall !== undefined &&
      zodType(def.catchall) !== "never";
    const out: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value)) {
      if (key in shape) out[key] = project(shape[key], member);
      else if (open) out[key] = member;
    }
    return out;
  }

  return value;
}

// =============================================================================
// Check
// =============================================================================

/** A request was answered with a status outside 200-299. */
class Refused extends Error {}

/** A law cannot be stated for this run. */
class Skipped extends Error {}

function readResource(resource: object, method: UpdateMethod): z.ZodType {
  const def = ("__apiDef" in resource ? resource.__apiDef : resource) as Record<
    string,
    { readonly body?: z.ZodType } | undefined
  >;
  if (!def.GET) {
    throw new Error("checkResourceLaws: the route does not define GET");
  }
  const body = def[method]?.body;
  if (!body) {
    throw new Error(
      `checkResourceLaws: the route does not define ${method} with a body schema`,
    );
  }
  return body;
}

/**
 * Check the lens laws of a resource against a server.
 *
 * @param resource A route that defines GET and PUT with a body schema: the
 * method definitions, or the handlers `createApiHandlers()` returns.
 * @param options Where the resource is, and how much to check.
 *
 * @example
 * ```ts
 * const report = await checkResourceLaws(handler, {
 *   url: "http://localhost:8000/api/notes/1",
 *   ignore: ["updatedAt"],
 * });
 * assert(report.ok, formatResourceLawsReport(report));
 * ```
 */
export function checkResourceLaws<T extends object>(
  resource: T & Resource<T, "PUT">,
  options: ResourceLawsOptions & { readonly method?: "PUT" },
): Promise<ResourceLawsReport>;
/**
 * Check the laws of a resource that is updated with PATCH.
 *
 * @param resource A route that defines GET and PATCH with a body schema.
 * @param options Where the resource is, and how much to check.
 */
export function checkResourceLaws<T extends object>(
  resource: T & Resource<T, "PATCH">,
  options: ResourceLawsOptions & { readonly method: "PATCH" },
): Promise<ResourceLawsReport>;
export async function checkResourceLaws(
  resource: object,
  options: ResourceLawsOptions & { readonly method?: UpdateMethod },
): Promise<ResourceLawsReport> {
  const method = options.method ?? "PUT";
  const schema = readResource(resource, method);
  const url = String(options.url);
  const send = options.send ?? ((request: Request) => fetch(request));
  const runs = options.runs ?? 20;
  const seed = options.seed ?? 0;
  const random = seededRandom(seed);
  const ignore = (options.ignore ?? []).map((path) => path.split("."));
  const laws = RESOURCE_LAWS.filter((law) =>
    options.laws ? options.laws.includes(law) : (
      method === "PUT" || law !== "put-put"
    )
  );

  const value = () =>
    options.value ? options.value(random) : arbitrary(schema, { random });

  /** What the server is expected to keep of a body: the parsed value. */
  const kept = (body: unknown): Json => {
    const parsed = schema.safeParse(body);
    return asJson(parsed.success ? parsed.data : body);
  };

  /** The view as a body: without the members the body has no place for. */
  const viewAsBody = (view: Json): Json => {
    const body = project(schema, view);
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const at = issue.path.join(".");
      throw new Skipped(
        `the view is not a ${method} body (${
          at ? `${at}: ` : ""
        }${issue.message})`,
      );
    }
    return body;
  };

  const results: Record<string, {
    held: number;
    violations: LawViolation[];
    refusals: LawRefusal[];
    skips: LawSkip[];
  }> = {};
  for (const law of laws) {
    results[law] = { held: 0, violations: [], refusals: [], skips: [] };
  }

  for (let run = 0; run < runs; run++) {
    for (const law of laws) {
      const exchanges: LawExchange[] = [];

      const exchange = async (verb: string, body?: unknown): Promise<Json> => {
        const sent = body === undefined ? undefined : asJson(body);
        const response = await send(
          new Request(url, {
            method: verb,
            headers: {
              ...(sent !== undefined && {
                "Content-Type": "application/json",
              }),
              Accept: "application/json",
              ...options.headers,
            },
            ...(sent !== undefined && { body: JSON.stringify(sent) }),
          }),
        );
        const text = await response.text();
        let answer: unknown = text;
        try {
          answer = JSON.parse(text);
        } catch {
          // Not JSON: the text is the answer.
        }
        exchanges.push({
          method: verb,
          ...(sent !== undefined && { body: sent }),
          status: response.status,
          response: answer,
        });
        if (!response.ok) throw new Refused();
        return answer;
      };
      const get = () => exchange("GET");
      const update = (body: unknown) => exchange(method, body);

      const result = results[law];
      try {
        let found: LawDifference[];
        switch (law) {
          case "get-get": {
            const first = await get();
            found = differences(first, await get(), false, ignore);
            break;
          }
          case "put-get": {
            const body = value();
            await update(body);
            found = differences(kept(body), await get(), true, ignore);
            break;
          }
          case "get-put": {
            const before = await get();
            await update(viewAsBody(before));
            found = differences(before, await get(), false, ignore);
            break;
          }
          case "put-put": {
            const last = value();
            const earlier = value();
            await update(last);
            const once = await get();
            await update(earlier);
            await update(last);
            found = differences(once, await get(), false, ignore);
            break;
          }
        }
        if (found.length === 0) result.held++;
        else result.violations.push({ run, exchanges, differences: found });
      } catch (error) {
        if (error instanceof Refused) result.refusals.push({ run, exchanges });
        else if (error instanceof Skipped) {
          result.skips.push({ run, reason: error.message });
        } else throw error;
      }
    }
  }

  return {
    url,
    method,
    seed,
    runs,
    laws: results,
    ok: laws.every((law) => results[law].held === runs),
  };
}

// =============================================================================
// Report
// =============================================================================

function show(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) return "undefined";
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function showDifference(
  law: ResourceLaw,
  difference: LawDifference,
): string {
  const at = difference.path === "" ? "(the view)" : difference.path;
  const expected = "expected" in difference
    ? show(difference.expected)
    : "absent";
  const actual = "actual" in difference ? show(difference.actual) : "absent";
  return law === "put-get"
    ? `${at}: put ${expected}, read ${actual}`
    : `${at}: was ${expected}, then ${actual}`;
}

function showExchanges(exchanges: readonly LawExchange[]): string {
  return exchanges
    .map((exchange) =>
      "body" in exchange
        ? `${exchange.method} ${show(exchange.body)}`
        : exchange.method
    )
    .join(", ");
}

/**
 * A report as text: one line per law, and for a law that did not hold, the
 * requests of the first run that shows it and the places that differ.
 *
 * @param report What `checkResourceLaws()` returned.
 */
export function formatResourceLawsReport(report: ResourceLawsReport): string {
  const lines = [
    `resource laws: ${report.method} ${report.url}, ${report.runs} runs, seed ${report.seed}`,
  ];
  for (const law of RESOURCE_LAWS) {
    const result = report.laws[law];
    if (!result) continue;

    const parts = [`held in ${result.held} of ${report.runs} runs`];
    if (result.violations.length > 0) {
      parts.push(`violated in ${result.violations.length}`);
    }
    if (result.refusals.length > 0) {
      parts.push(`refused in ${result.refusals.length}`);
    }
    if (result.skips.length > 0) {
      parts.push(`not stated in ${result.skips.length}`);
    }
    lines.push(`  ${law}: ${parts.join(", ")}`);

    const violation = result.violations[0];
    if (violation) {
      lines.push(
        `    run ${violation.run}: ${showExchanges(violation.exchanges)}`,
      );
      for (const difference of violation.differences) {
        lines.push(`      ${showDifference(law, difference)}`);
      }
    }
    const refusal = result.refusals[0];
    if (refusal) {
      const last = refusal.exchanges[refusal.exchanges.length - 1];
      lines.push(
        `    run ${refusal.run}: ${
          showExchanges(refusal.exchanges)
        }: answered ${last.status} ${show(last.response)}`,
      );
    }
    const skip = result.skips[0];
    if (skip) lines.push(`    run ${skip.run}: ${skip.reason}`);
  }
  return lines.join("\n");
}

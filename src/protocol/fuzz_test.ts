/**
 * Protocol fuzzing against an in-memory OAuth server, correct and with
 * planted defects.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { z } from "zod";

import type { StepExecutor } from "./client.ts";
import { dependentStep, mappedStep, protocol, revoking, step } from "./dsl.ts";
import {
  formatFuzzReport,
  type FuzzFinding,
  fuzzProtocol,
  type FuzzReport,
} from "./fuzz.ts";
import { fromStep } from "./mapping.ts";
import { oauth2AuthCodeProtocol } from "./oauth.ts";

// -----------------------------------------------------------------------------
// An authorization server
// -----------------------------------------------------------------------------

interface Defects {
  /** An authorization code can be exchanged more than once. */
  readonly reusableCodes?: boolean;
  /** Any code is exchanged, issued or not. */
  readonly anyCode?: boolean;
  /** Revoking a token leaves its refresh token valid. */
  readonly refreshSurvivesRevoke?: boolean;
  /** The token response lacks a required field. */
  readonly malformedTokens?: boolean;
}

/**
 * An OAuth 2.0 authorization server, as an executor. Refusals are error
 * variants, as in the RFC, not thrown errors.
 */
function authorizationServer(defects: Defects = {}): StepExecutor {
  interface Grant {
    /** Every access token issued for the grant; the last one is current. */
    readonly access: string[];
    readonly refresh?: string;
    revoked: boolean;
  }
  const codes = new Map<string, { used: boolean }>();
  const grants: Grant[] = [];
  let counter = 0;
  const next = (prefix: string) => `${prefix}-${++counter}`;

  const tokens = (grant: Grant) => ({
    type: "success" as const,
    access_token: grant.access.at(-1),
    ...(!defects.malformedTokens && { token_type: "Bearer" as const }),
    expires_in: 3600,
    ...(grant.refresh && { refresh_token: grant.refresh }),
  });
  const invalidGrant = { type: "error" as const, error: "invalid_grant" };

  return {
    // deno-lint-ignore no-explicit-any
    execute(name: string, request: any) {
      switch (name) {
        case "authorize": {
          // The user denies some requests.
          if (request.client_id.length % 3 === 0) {
            return Promise.resolve({
              type: "error",
              error: "access_denied",
              state: request.state,
            });
          }
          const code = next("code");
          codes.set(code, { used: false });
          return Promise.resolve({
            type: "success",
            code,
            state: request.state,
          });
        }
        case "exchange": {
          const entry = codes.get(request.code);
          if (!entry && !defects.anyCode) return Promise.resolve(invalidGrant);
          if (entry?.used && !defects.reusableCodes) {
            return Promise.resolve(invalidGrant);
          }
          if (entry) entry.used = true;
          // Some clients get no refresh token.
          const grant: Grant = {
            access: [next("access")],
            ...(request.client_id.length % 2 === 0 &&
              { refresh: next("refresh") }),
            revoked: false,
          };
          grants.push(grant);
          return Promise.resolve(tokens(grant));
        }
        case "refresh": {
          const grant = grants.find((g) =>
            g.refresh === request.refresh_token &&
            (!g.revoked || defects.refreshSurvivesRevoke)
          );
          if (!grant) return Promise.resolve(invalidGrant);
          grant.access.push(next("access"));
          return Promise.resolve(tokens(grant));
        }
        case "revoke": {
          // Revoking any token of a grant ends the grant.
          for (const grant of grants) {
            if (
              grant.access.includes(request.token) ||
              grant.refresh === request.token
            ) {
              grant.revoked = true;
            }
          }
          // RFC 7009, section 2.2: the answer is the same for a token the
          // server does not know.
          return Promise.resolve({ revoked: true });
        }
        default:
          return Promise.reject(new Error(`unknown step ${name}`));
      }
    },
  };
}

const isRefusal = (_step: string, response: unknown) =>
  (response as { type?: string }).type === "error";

function fuzzOAuth(defects: Defects = {}, seed = 1): Promise<FuzzReport> {
  return fuzzProtocol(
    oauth2AuthCodeProtocol,
    () => authorizationServer(defects),
    {
      seed,
      runs: 40,
      isRefusal,
      // The server answers `revoke` the same way in every state.
      probes: (step) => step !== "revoke",
    },
  );
}

type Accepted = Extract<FuzzFinding, { kind: "forbidden-accepted" }>;
const accepted = (report: FuzzReport): Accepted[] =>
  report.findings.filter((f): f is Accepted => f.kind === "forbidden-accepted");

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

Deno.test("fuzz: a correct server refuses every forbidden call", async () => {
  const report = await fuzzOAuth();

  assertEquals(report.findings, [], formatFuzzReport(report));
  assertEquals(report.allowed.accepted, report.allowed.sent);
  // The walks reached every step, and every kind of forbidden call was sent.
  assertEquals(report.covered, ["authorize", "exchange", "refresh", "revoke"]);
  for (const [reason, count] of Object.entries(report.forbidden)) {
    assertEquals(count.sent > 0, true, `no ${reason} call was sent`);
    assertEquals(count.refused, count.sent, reason);
  }
  assertEquals(report.skipped, {});
});

Deno.test("fuzz: finds a server that exchanges one code twice", async () => {
  const report = await fuzzOAuth({ reusableCodes: true });
  const found = accepted(report);

  assertEquals(found.length > 0, true, formatFuzzReport(report));
  // Every finding is the same defect: `exchange`, after its authorization
  // was spent, with the request that was accepted before.
  for (const finding of found) {
    assertEquals(finding.step, "exchange");
    assertEquals(finding.replay, true);
    assertEquals(
      finding.reason === "revoked" || finding.reason === "wrong-variant",
      true,
    );
  }
  // The history shows the first exchange of that code.
  const first = found[0];
  const earlier = first.history.findLast((call) => call.step === "exchange");
  assertEquals(earlier?.request, first.request);

  assertStringIncludes(
    formatFuzzReport(report),
    'the server accepted "exchange" (revoked, replayed request)',
  );
});

Deno.test("fuzz: finds a server that exchanges a code it never issued", async () => {
  const report = await fuzzOAuth({ anyCode: true });
  const found = accepted(report);

  const reasons = new Set(found.map((finding) => finding.reason));
  // Before any authorization, after a denied one, and next to a real code.
  assertEquals(reasons.has("before-dependency"), true);
  assertEquals(reasons.has("wrong-variant"), true);
  assertEquals(reasons.has("forged"), true);
  for (const finding of found) assertEquals(finding.step, "exchange");
});

Deno.test("fuzz: finds a refresh token that survives revocation", async () => {
  const report = await fuzzOAuth({ refreshSurvivesRevoke: true });
  const found = accepted(report);

  assertEquals(found.length > 0, true, formatFuzzReport(report));
  for (const finding of found) {
    assertEquals(finding.step, "refresh");
    assertEquals(finding.reason, "revoked");
    assertEquals(finding.history.at(-1)?.step, "revoke");
  }
});

Deno.test("fuzz: reports a response that does not fit its schema", async () => {
  const report = await fuzzOAuth({ malformedTokens: true });
  const invalid = report.findings.filter((f) => f.kind === "invalid-response");

  assertEquals(invalid.length > 0, true);
  assertEquals(invalid[0].step, "exchange");
  assertStringIncludes(invalid[0].issue, "token_type");
  // No walk got past the exchange.
  assertEquals(report.covered.includes("refresh"), false);
  assertEquals(report.covered.includes("revoke"), false);
});

Deno.test("fuzz: the verdict does not depend on the seed", async () => {
  for (let seed = 0; seed < 20; seed++) {
    const correct = await fuzzOAuth({}, seed);
    assertEquals(correct.findings, [], formatFuzzReport(correct));

    for (
      const defect of [
        { reusableCodes: true },
        { anyCode: true },
        { refreshSurvivesRevoke: true },
      ]
    ) {
      const report = await fuzzOAuth(defect, seed);
      assertEquals(
        accepted(report).length > 0,
        true,
        `seed ${seed} missed ${JSON.stringify(defect)}`,
      );
    }
  }
});

Deno.test("fuzz: the same seed gives the same report", async () => {
  const one = await fuzzOAuth({ reusableCodes: true });
  const two = await fuzzOAuth({ reusableCodes: true });
  assertEquals(formatFuzzReport(one), formatFuzzReport(two));
  assertEquals(one.findings.length, two.findings.length);
});

// -----------------------------------------------------------------------------
// Thrown refusals, mapped steps, custom requests
// -----------------------------------------------------------------------------

const login = step({
  name: "login",
  request: z.object({ user: z.string().min(1), password: z.string() }),
  response: z.object({ session: z.string() }),
});

const whoami = mappedStep({
  name: "whoami",
  dependsOn: "login",
  requestMapping: { session: fromStep("login", "session") },
  requestSchema: z.object({ session: z.string() }),
  response: z.object({ user: z.string() }),
});

// Ends the session: without `revoking`, the protocol would allow a second
// logout, which the service refuses. The fuzzer reports that as an allowed
// call the server refused.
const logout = revoking(
  dependentStep({
    name: "logout",
    dependsOn: login,
    request: (prev) => z.object({ session: z.literal(prev.session) }),
    response: z.object({ ok: z.literal(true) }),
  }),
  ["login"],
);

const sessions = protocol({
  name: "Sessions",
  initial: "login",
  steps: { login, whoami, logout },
});

/** A session service that refuses by throwing, like an HTTP 401. */
function sessionService(defects: { trustsAnySession?: boolean } = {}) {
  return (): StepExecutor => {
    const open = new Map<string, string>();
    let counter = 0;
    return {
      // deno-lint-ignore no-explicit-any
      execute(name: string, request: any) {
        if (name === "login") {
          if (request.password !== "secret") {
            return Promise.reject(new Error("401"));
          }
          const session = `s${++counter}`;
          open.set(session, request.user);
          return Promise.resolve({ session });
        }
        const user = open.get(request.session);
        if (user === undefined && !defects.trustsAnySession) {
          return Promise.reject(new Error("401"));
        }
        if (name === "logout") {
          open.delete(request.session);
          return Promise.resolve({ ok: true });
        }
        return Promise.resolve({ user: user ?? "nobody" });
      },
    };
  };
}

Deno.test("fuzz: custom requests supply what cannot be generated", async () => {
  // A generated password is refused: allowed calls fail, nothing is reached.
  const blind = await fuzzProtocol(sessions, sessionService(), { runs: 5 });
  assertEquals(blind.covered, []);
  assertEquals(
    blind.findings.every((f) => f.kind === "allowed-refused"),
    true,
  );

  const report = await fuzzProtocol(sessions, sessionService(), {
    runs: 20,
    requests: {
      login: ({ schema, random }) => ({
        ...(schema.parse({ user: "ada", password: "secret" }) as object),
        user: `user-${Math.floor(random() * 10)}`,
      }),
    },
  });
  assertEquals(report.findings, [], formatFuzzReport(report));
  assertEquals(report.covered, ["login", "whoami", "logout"]);
  assertEquals(report.skipped, {});
  assertEquals(report.forbidden["before-dependency"].sent > 0, true);
  assertEquals(report.forbidden.forged.sent > 0, true);
});

Deno.test("fuzz: finds a service that trusts any session id", async () => {
  const report = await fuzzProtocol(
    sessions,
    sessionService({ trustsAnySession: true }),
    {
      runs: 10,
      requests: { login: () => ({ user: "ada", password: "secret" }) },
    },
  );
  const found = accepted(report);
  const kinds = new Set(found.map((f) => `${f.step}:${f.reason}`));
  assertEquals(kinds.has("whoami:before-dependency"), true);
  assertEquals(kinds.has("whoami:forged"), true);
  assertEquals(kinds.has("logout:forged"), true);
});

Deno.test("fuzz: a session that was superseded, not ended, is not replayed", async () => {
  // Two logins give two sessions. Logging out of the second leaves the
  // first one open, and the service is right to keep answering for it: a
  // request made for the first login is no replay of a revoked one.
  for (let seed = 0; seed < 60; seed++) {
    const report = await fuzzProtocol(sessions, sessionService(), {
      seed,
      runs: 10,
      requests: { login: () => ({ user: "ada", password: "secret" }) },
    });
    assertEquals(report.findings, [], formatFuzzReport(report));
  }
});

Deno.test("fuzz: probes can be limited to some reasons", async () => {
  const report = await fuzzProtocol(
    sessions,
    sessionService({ trustsAnySession: true }),
    {
      runs: 10,
      probes: ["before-dependency"],
      requests: { login: () => ({ user: "ada", password: "secret" }) },
    },
  );
  assertEquals(report.forbidden.forged.sent, 0);
  assertEquals(
    accepted(report).every((f) => f.reason === "before-dependency"),
    true,
  );
});

Deno.test("fuzz: one executor can be shared by every walk", async () => {
  const shared = sessionService()();
  const report = await fuzzProtocol(sessions, shared, {
    runs: 5,
    requests: { login: () => ({ user: "ada", password: "secret" }) },
  });
  assertEquals(report.findings, []);
});

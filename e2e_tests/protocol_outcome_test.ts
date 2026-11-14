/**
 * E2E: a protocol step that branches on an HTTP error status.
 *
 * A real token endpoint answers a bad grant with HTTP 400 and an error
 * body (RFC 6749, section 5.2), not with a 200 that carries a `type`
 * field. The endpoints here declare their error responses per status
 * (`responses: { 403: ... }`); a step made from them with `outcome: true`
 * has `{ ok, status, body }` as its response, one variant per declared
 * status. Sessions, plans and the fuzzer then work on real statuses,
 * without `try`/`catch`.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { z } from "zod";

import { createApiHandlers, endpoint } from "../src/integrations/fresh.ts";
import {
  branch,
  createHttpExecutor,
  createSession,
  formatFuzzReport,
  fromEndpoint,
  fromEndpointMapped,
  fromStep,
  fuzzProtocol,
  HttpError,
  type PlanOf,
  protocol,
  revoking,
  runPlan,
  sequence,
} from "../src/protocol/index.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
function assertType<_T extends true>(): void {}

// -----------------------------------------------------------------------------
// An authorization service that answers with HTTP statuses
// -----------------------------------------------------------------------------

const Denied = z.object({ error: z.literal("access_denied") });
const InvalidGrant = z.object({ error: z.literal("invalid_grant") });

function service(defects: { reusableCodes?: boolean } = {}) {
  /** Issued codes; true once exchanged. */
  const codes = new Map<string, boolean>();

  // routes/api/authorize.ts
  const authorize = createApiHandlers({
    POST: endpoint({
      body: z.strictObject({
        client_id: z.string().min(1),
        scope: z.enum(["read", "admin"]),
      }),
      response: z.object({ code: z.string() }),
      responses: { 403: Denied },
      public: true,
      handler: (_ctx, { body }) => {
        if (body.scope === "admin") {
          return Response.json({ error: "access_denied" }, { status: 403 });
        }
        const code = crypto.randomUUID();
        codes.set(code, false);
        return { code };
      },
    }),
  });

  // routes/api/token.ts
  const token = createApiHandlers({
    POST: endpoint({
      body: z.strictObject({ code: z.string() }),
      response: z.object({ access_token: z.string() }),
      responses: { 400: InvalidGrant },
      public: true,
      handler: (_ctx, { body }) => {
        const used = codes.get(body.code);
        if (used === undefined || (used && !defects.reusableCodes)) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        codes.set(body.code, true);
        return { access_token: `token-for-${body.code}` };
      },
    }),
  });

  return { authorize, token };
}

// The steps read the endpoint definitions only.
const definitions = service();

const authorize = fromEndpoint(definitions.authorize, "POST", {
  name: "authorize",
  path: "/api/authorize",
  outcome: true,
});

const exchange = revoking(
  fromEndpointMapped(definitions.token, "POST", {
    name: "exchange",
    path: "/api/token",
    outcome: true,
    dependsOn: "authorize",
    // `body.code` exists on the 200 outcome of `authorize` only.
    requestMapping: { code: fromStep("authorize", "body.code") },
  }),
  ["authorize"],
);

const grant = protocol({
  name: "Grant",
  initial: "authorize",
  steps: { authorize, exchange },
});

function serve(defects: { reusableCodes?: boolean } = {}) {
  type Handler = (ctx: unknown) => Promise<Response>;
  const handlers = service(defects);
  const table: Record<string, { POST: unknown }> = {
    "/api/authorize": handlers.authorize,
    "/api/token": handlers.token,
  };
  const statuses: number[] = [];
  const server = Deno.serve({ port: 0, onListen: () => {} }, async (req) => {
    const handler = table[new URL(req.url).pathname]?.POST as
      | Handler
      | undefined;
    const response = handler
      ? await handler({ req, params: {} })
      : new Response("Not Found", { status: 404 });
    statuses.push(response.status);
    return response;
  });
  return {
    executor: createHttpExecutor(grant, {
      baseUrl: `http://localhost:${server.addr.port}`,
    }),
    statuses,
    close: () => server.shutdown(),
  };
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

Deno.test("E2E outcome: a step's response has one variant per declared status", () => {
  assertType<
    Equal<
      z.output<typeof authorize.response>,
      | {
        readonly ok: true;
        readonly status: number;
        readonly body: { code: string };
      }
      | {
        readonly ok: false;
        readonly status: 403;
        readonly body: { error: "access_denied" };
      }
    >
  >();
  assertType<
    Equal<
      z.output<typeof exchange.response>,
      | {
        readonly ok: true;
        readonly status: number;
        readonly body: { access_token: string };
      }
      | {
        readonly ok: false;
        readonly status: 400;
        readonly body: { error: "invalid_grant" };
      }
    >
  >();
  // What the executor has to treat as a response.
  assertEquals(authorize.outcome, { errors: [403] });
  assertEquals(exchange.outcome, { errors: [400] });
});

Deno.test("E2E outcome: a session follows a granted authorization", async () => {
  const { executor, statuses, close } = serve();
  try {
    const { response, session } = await createSession(grant, executor)
      .execute("authorize", { client_id: "app", scope: "read" });
    assert(response.ok);
    assertEquals(response.status, 200);

    // `exchange` forwards `body.code`: available once the outcome is
    // known to be the 200.
    const granted = session.ready("exchange");
    assert(granted);
    const { response: tokens } = await granted.execute("exchange", {
      code: response.body.code,
    });
    assertEquals(tokens, {
      ok: true,
      status: 200,
      body: { access_token: `token-for-${response.body.code}` },
    });
    assertEquals(statuses, [200, 200]);
  } finally {
    await close();
  }
});

Deno.test("E2E outcome: a denied authorization is a response, not an exception", async () => {
  const { executor, statuses, close } = serve();
  try {
    const { response, session } = await createSession(grant, executor)
      .execute("authorize", { client_id: "app", scope: "admin" });

    // HTTP 403 with the declared body: a value.
    assertEquals(response, {
      ok: false,
      status: 403,
      body: { error: "access_denied" },
    });
    assertEquals(statuses, [403]);

    // There is no code to exchange, for the session and for the compiler.
    assertEquals(session.ready("exchange"), undefined);
    assertEquals(session.canExecute("exchange"), false);
    const direct = () =>
      // @ts-expect-error `authorize` is not known to have a `body.code`
      session.execute("exchange", { code: "made-up" });
    void direct;
  } finally {
    await close();
  }
});

Deno.test("E2E outcome: a plan branches on the status", async () => {
  const flow = sequence(
    authorize,
    branch(authorize, (outcome) => outcome.ok, {
      then: exchange,
      else: sequence(),
    }),
  );
  const plan = (scope: "read" | "admin"): PlanOf<typeof flow> => ({
    first: { client_id: "app", scope },
    rest: () => ({
      // `outcome` is the 200 variant here.
      ifTrue: (outcome) => ({ code: outcome.body.code }),
      ifFalse: () => undefined,
    }),
  });

  const { executor, statuses, close } = serve();
  try {
    const [, granted] = await runPlan(flow, plan("read"), executor);
    assert(granted.holds);
    assert(granted.result.ok);
    assertEquals(granted.result.status, 200);

    const [denied, nothing] = await runPlan(flow, plan("admin"), executor);
    assertEquals(denied.status, 403);
    assertEquals(nothing, { holds: false, result: [] });

    assertEquals(statuses, [200, 200, 403]);
  } finally {
    await close();
  }
});

Deno.test("E2E outcome: a status the endpoint does not declare is still an error", async () => {
  const { executor, close } = serve();
  try {
    const context = { protocol: "Grant", history: [], responses: {} };

    // A spent or unknown code: HTTP 400, declared, a response.
    assertEquals(
      await executor.execute("exchange", { code: "made-up" }, context),
      { ok: false, status: 400, body: { error: "invalid_grant" } },
    );

    // A request the endpoint's own validation rejects: also HTTP 400 for
    // `authorize`, which declares 403 only.
    const error = await assertRejects(
      () => executor.execute("authorize", { client_id: "" }, context),
      HttpError,
    );
    assertEquals(error.status, 400);
  } finally {
    await close();
  }
});

Deno.test("E2E outcome: the fuzzer reads refusals from the status", async () => {
  const fuzz = (executor: ReturnType<typeof serve>["executor"]) =>
    fuzzProtocol(grant, executor, {
      seed: 5,
      runs: 15,
      isRefusal: (_step, response) => !(response as { ok: boolean }).ok,
    });

  const correct = serve();
  try {
    const report = await fuzz(correct.executor);
    assertEquals(report.findings, [], formatFuzzReport(report));
    assertEquals(report.covered, ["authorize", "exchange"]);
    // Denied authorizations are allowed calls the server declined.
    assertEquals(Object.keys(report.declined), ["authorize"]);
    // Every forbidden exchange arrived and was answered 400.
    const refused = report.forbidden["before-dependency"].refused +
      report.forbidden["wrong-variant"].refused +
      report.forbidden.revoked.refused + report.forbidden.forged.refused;
    assertEquals(refused > 0, true);
    assertEquals(
      correct.statuses.filter((status) => status === 400).length,
      refused,
    );
  } finally {
    await correct.close();
  }

  const defective = serve({ reusableCodes: true });
  try {
    const report = await fuzz(defective.executor);
    const found = report.findings.filter((finding) =>
      finding.kind === "forbidden-accepted"
    );
    assertEquals(found.length > 0, true, formatFuzzReport(report));
    for (const finding of found) {
      assertEquals(finding.step, "exchange");
      assertEquals(finding.replay, true);
    }
  } finally {
    await defective.close();
  }
});

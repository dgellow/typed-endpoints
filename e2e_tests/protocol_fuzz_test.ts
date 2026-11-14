/**
 * E2E: fuzzing a protocol over HTTP.
 *
 * The steps come from endpoint definitions, the endpoints are served by a
 * real HTTP server, and the fuzzer sends its calls through the HTTP
 * executor. A refusal is an HTTP error status.
 *
 * The session types keep a client from asking `whoami` after `logout`.
 * This test asks whether the server does.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { z } from "zod";

import { createApiHandlers, endpoint } from "../src/integrations/fresh.ts";
import {
  createHttpExecutor,
  formatFuzzReport,
  fromEndpoint,
  fromEndpointMapped,
  fromStep,
  fuzzProtocol,
  HttpError,
  protocol,
  revoking,
} from "../src/protocol/index.ts";

// -----------------------------------------------------------------------------
// A session service
// -----------------------------------------------------------------------------

interface Defects {
  /** `DELETE /api/session` answers 200 and leaves the session open. */
  readonly logoutKeepsSession?: boolean;
}

function sessionService(defects: Defects = {}) {
  const open = new Map<string, string>();
  const unauthorized = () =>
    Response.json({ error: "unauthorized" }, { status: 401 });

  // routes/api/session.ts
  const session = createApiHandlers({
    POST: endpoint({
      body: z.strictObject({ user: z.string().min(1), password: z.string() }),
      response: z.object({ token: z.string() }),
      public: true,
      handler: (_ctx, { body }) => {
        if (body.password !== "secret") return unauthorized();
        const token = crypto.randomUUID();
        open.set(token, body.user);
        return { token };
      },
    }),
    DELETE: endpoint({
      query: z.object({ token: z.string() }),
      response: z.object({ closed: z.literal(true) }),
      public: true,
      handler: (_ctx, { query }) => {
        if (!open.has(query.token)) return unauthorized();
        if (!defects.logoutKeepsSession) open.delete(query.token);
        return { closed: true as const };
      },
    }),
  });

  // routes/api/me.ts
  const me = createApiHandlers({
    GET: endpoint({
      query: z.object({ token: z.string() }),
      response: z.object({ user: z.string() }),
      public: true,
      handler: (_ctx, { query }) => {
        const user = open.get(query.token);
        return user === undefined ? unauthorized() : { user };
      },
    }),
  });

  return { session, me };
}

// The protocol is the same for every instance of the service: the steps
// only read the endpoint definitions.
const definitions = sessionService();

const login = fromEndpoint(definitions.session, "POST", {
  name: "login",
  path: "/api/session",
});

const whoami = fromEndpointMapped(definitions.me, "GET", {
  name: "whoami",
  path: "/api/me",
  dependsOn: "login",
  requestMapping: { token: fromStep("login", "token") },
});

const logout = revoking(
  fromEndpointMapped(definitions.session, "DELETE", {
    name: "logout",
    path: "/api/session",
    dependsOn: "login",
    requestMapping: { token: fromStep("login", "token") },
  }),
  ["login"],
);

const sessions = protocol({
  name: "Sessions",
  initial: "login",
  steps: { login, whoami, logout },
});

function serve(defects: Defects = {}): {
  readonly baseUrl: string;
  readonly statuses: number[];
  readonly close: () => Promise<void>;
} {
  type Handler = (ctx: unknown) => Promise<Response>;
  const service = sessionService(defects);
  const table: Record<string, Record<string, unknown>> = {
    "/api/session": service.session,
    "/api/me": service.me,
  };
  const statuses: number[] = [];

  const server = Deno.serve({ port: 0, onListen: () => {} }, async (req) => {
    const { pathname } = new URL(req.url);
    const handler = table[pathname]?.[req.method] as Handler | undefined;
    const response = handler
      ? await handler({ req, params: {} })
      : new Response("Not Found", { status: 404 });
    statuses.push(response.status);
    return response;
  });

  return {
    baseUrl: `http://localhost:${server.addr.port}`,
    statuses,
    close: () => server.shutdown(),
  };
}

function fuzz(baseUrl: string) {
  return fuzzProtocol(
    sessions,
    createHttpExecutor(sessions, { baseUrl }),
    {
      seed: 3,
      runs: 15,
      // A generated password is not the password.
      requests: {
        login: ({ random }) => ({
          user: `user-${Math.floor(random() * 5)}`,
          password: "secret",
        }),
      },
    },
  );
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

Deno.test("E2E fuzz: the service refuses every call the protocol forbids", async () => {
  const server = serve();
  try {
    const report = await fuzz(server.baseUrl);

    assertEquals(report.findings, [], formatFuzzReport(report));
    assertEquals(report.covered, ["login", "whoami", "logout"]);
    assertEquals(report.allowed.accepted, report.allowed.sent);

    // Forbidden calls went over the wire and were refused there.
    const sent = report.forbidden["before-dependency"].sent +
      report.forbidden.revoked.sent + report.forbidden.forged.sent;
    assertEquals(sent > 0, true);
    assertEquals(
      server.statuses.filter((status) => status === 401).length,
      sent,
    );
    assertEquals(
      server.statuses.filter((status) => status === 200).length,
      report.allowed.sent,
    );
  } finally {
    await server.close();
  }
});

Deno.test("E2E fuzz: finds a logout that leaves the session open", async () => {
  const server = serve({ logoutKeepsSession: true });
  try {
    const report = await fuzz(server.baseUrl);
    const found = report.findings.filter((finding) =>
      finding.kind === "forbidden-accepted"
    );

    assertEquals(found.length > 0, true, formatFuzzReport(report));
    for (const finding of found) {
      // After `logout`, the token still works: for `whoami`, and for a
      // second `logout`.
      assertEquals(finding.reason, "revoked");
      assertEquals(finding.replay, true);
      assertEquals(finding.history.at(-1)?.step, "logout");
    }
    assertEquals(
      new Set(found.map((finding) => finding.step)),
      new Set(["whoami", "logout"]),
    );
    assertStringIncludes(
      formatFuzzReport(report),
      'the server accepted "whoami" (revoked, replayed request)',
    );
  } finally {
    await server.close();
  }
});

Deno.test("E2E fuzz: an HTTP error status is a refusal", async () => {
  const server = serve();
  try {
    const executor = createHttpExecutor(sessions, {
      baseUrl: server.baseUrl,
    });
    let status = 0;
    try {
      await executor.execute("whoami", { token: "made-up" }, {
        protocol: "Sessions",
        history: [],
        responses: {},
      });
    } catch (error) {
      if (error instanceof HttpError) status = error.status;
    }
    assertEquals(status, 401);
  } finally {
    await server.close();
  }
});

/**
 * E2E: a session that is dropped releases what it holds on the server.
 *
 * A lock service over HTTP: POST acquires a lock and returns its token,
 * PUT renews it, DELETE releases it. The protocol names the release step
 * as `onAbandon`. A client block that is left early, by an early return
 * or by an exception, leaves no lock behind on the server.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { z } from "zod";

import {
  createApiHandlers,
  createRouter,
  endpoint,
} from "@/integrations/fetch.ts";
import {
  createHttpExecutor,
  createSession,
  fromEndpoint,
  fromEndpointMapped,
  fromStep,
  protocol,
  SessionAbandonedError,
} from "@/protocol/index.ts";

// =============================================================================
// Server
// =============================================================================

const held = new Map<string, { resource: string; renewals: number }>();
const log: string[] = [];
let issued = 0;

const Lock = z.object({ token: z.string(), resource: z.string() });
const Token = z.object({ token: z.string() });

const locks = createApiHandlers({
  POST: endpoint({
    body: z.object({ resource: z.string() }),
    response: Lock,
    handler: (_request, { body }) => {
      const token = `lock-${++issued}`;
      held.set(token, { resource: body.resource, renewals: 0 });
      log.push(`acquire ${token}`);
      return { token, resource: body.resource };
    },
  }),
});

const lock = createApiHandlers({
  PUT: endpoint({
    params: Token,
    response: z.object({ renewals: z.number() }),
    handler: (_request, { params }) => {
      const entry = held.get(params.token);
      if (!entry) return Response.json({ error: "gone" }, { status: 404 });
      log.push(`renew ${params.token}`);
      return { renewals: ++entry.renewals };
    },
  }),
  DELETE: endpoint({
    params: Token,
    response: z.object({ released: z.boolean() }),
    handler: (_request, { params }) => {
      log.push(`release ${params.token}`);
      return { released: held.delete(params.token) };
    },
  }),
});

// =============================================================================
// Protocol
// =============================================================================

const token = { token: fromStep("acquire", "token") };

const locking = protocol({
  name: "Locking",
  initial: "acquire",
  terminal: ["release"],
  onAbandon: "release",
  steps: {
    acquire: fromEndpoint(locks, "POST", {
      name: "acquire",
      path: "/api/locks",
    }),
    renew: fromEndpointMapped(lock, "PUT", {
      name: "renew",
      dependsOn: "acquire",
      requestMapping: token,
      path: "/api/locks/[token]",
    }),
    release: fromEndpointMapped(lock, "DELETE", {
      name: "release",
      dependsOn: "acquire",
      requestMapping: token,
      path: "/api/locks/[token]",
    }),
  },
});

async function withServer(
  run: (
    start: (options?: { linear?: boolean }) => ReturnType<
      typeof createSession<typeof locking.steps>
    >,
  ) => Promise<void>,
): Promise<void> {
  held.clear();
  log.length = 0;
  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    createRouter({ "/api/locks": locks, "/api/locks/[token]": lock }),
  );
  const executor = createHttpExecutor(locking, {
    baseUrl: `http://localhost:${server.addr.port}`,
  });
  try {
    await run((options) => createSession(locking, executor, options));
  } finally {
    await server.shutdown();
  }
}

// =============================================================================
// Tests
// =============================================================================

Deno.test("E2E abandon: a block left early releases the lock on the server", async () => {
  await withServer(async (start) => {
    const renewals = await (async () => {
      await using session = start();
      const acquired = await session.execute("acquire", { resource: "db" });
      // The token is forwarded: the session fills it into the path.
      const renewed = await acquired.session.execute("renew", {});
      // The lock is held while the block runs.
      assertEquals(held.size, 1);
      return renewed.response.renewals;
    })();

    assertEquals(renewals, 1);
    assertEquals(held.size, 0);
    assertEquals(log.map((line) => line.split(" ")[0]), [
      "acquire",
      "renew",
      "release",
    ]);
  });
});

Deno.test("E2E abandon: an exception in the block releases the lock and is thrown", async () => {
  await withServer(async (start) => {
    await assertRejects(
      async () => {
        await using session = start();
        await session.execute("acquire", { resource: "db" });
        throw new TypeError("work failed");
      },
      TypeError,
      "work failed",
    );
    assertEquals(held.size, 0);
  });
});

Deno.test("E2E abandon: a lock that was released is not released again", async () => {
  await withServer(async (start) => {
    {
      await using session = start();
      const acquired = await session.execute("acquire", { resource: "db" });
      const { token } = acquired.response;
      const released = await acquired.session.execute("release", { token });
      assertEquals(released.response, { released: true });
    }
    assertEquals(log.filter((line) => line.startsWith("release")).length, 1);
  });
});

Deno.test("E2E abandon: a linear session releases the lock and reports the early end", async () => {
  await withServer(async (start) => {
    const error = await assertRejects(async () => {
      await using session = start({ linear: true });
      await session.execute("acquire", { resource: "db" });
    }, SessionAbandonedError);

    assertEquals(error.history, ["acquire"]);
    assertEquals(error.released, "release");
    assertEquals(held.size, 0);
  });
});

/**
 * E2E: an SSE handler that fails is a failure for the client.
 *
 * A stream has no status code once it has begun. A handler that throws,
 * or yields an event its schema rejects, ends the stream with a comment
 * line that says so. Over real HTTP the client then sees a failure, not
 * the end of the events: it reconnects with the id of the last event it
 * received, and gives up after `maxReconnectAttempts` connections in a
 * row that brought no event.
 */

import { assertEquals, assertRejects } from "@std/assert";
import { z } from "zod";

import { createClient, SseStreamError } from "../src/client/index.ts";
import { createApiHandlers, sseEndpoint } from "../src/integrations/fresh.ts";

type Api = {
  ticks: {
    subscribe: { events: { tick: { n: number } } };
  };
};

/** Serve one SSE handler; `connections` lists the Last-Event-ID of each. */
function serve(
  handler: (
    lastEventId: string | undefined,
    connection: number,
  ) => AsyncGenerator<
    { event: "tick"; data: { n: number }; id?: string },
    void,
    unknown
  >,
) {
  const connections: (string | undefined)[] = [];
  const handlers = createApiHandlers({
    GET: sseEndpoint({
      events: { tick: z.object({ n: z.number() }) },
      handler: (_ctx, { lastEventId }) => {
        connections.push(lastEventId);
        return handler(lastEventId, connections.length);
      },
    }),
  });

  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args);

  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    (req) => handlers.GET({ req, params: {} } as never),
  );
  return {
    client: createClient<Api>({
      baseUrl: `http://localhost:${server.addr.port}`,
      basePath: "",
    }),
    connections,
    errors,
    close: async () => {
      await server.shutdown();
      console.error = original;
    },
  };
}

Deno.test("E2E SSE: a handler that throws is a failure for the client, which resumes", async () => {
  const { client, connections, errors, close } = serve(
    async function* (lastEventId, connection) {
      const from = lastEventId === undefined ? 0 : Number(lastEventId) + 1;
      for (let n = from; n < 4; n++) {
        // The first connection breaks after two events.
        if (connection === 1 && n === 2) throw new Error("backend went away");
        yield { event: "tick", data: { n }, id: String(n) };
      }
    },
  );
  try {
    const seen: number[] = [];
    for await (
      const event of client.ticks.subscribe({ reconnectDelay: 5 })
    ) {
      seen.push(event.data.n);
    }

    // Every event once, in order: the second connection continued after
    // the last event of the first.
    assertEquals(seen, [0, 1, 2, 3]);
    assertEquals(connections, [undefined, "1"]);
    assertEquals(errors.length, 1);
    assertEquals(errors[0][0], "GET /ticks: SSE stream error:");
  } finally {
    await close();
  }
});

Deno.test("E2E SSE: a handler that always fails ends the subscription with an error", async () => {
  const { client, connections, close } = serve(
    // deno-lint-ignore require-yield
    async function* () {
      throw new Error("always");
    },
  );
  try {
    const seen: number[] = [];
    await assertRejects(
      async () => {
        for await (
          const event of client.ticks.subscribe({
            reconnectDelay: 5,
            maxReconnectAttempts: 3,
          })
        ) {
          seen.push(event.data.n);
        }
      },
      SseStreamError,
      "The server ended the event stream after a failure",
    );
    assertEquals(seen, []);
    // Three connections, none of which brought an event.
    assertEquals(connections.length, 3);
  } finally {
    await close();
  }
});

Deno.test("E2E SSE: an event its schema rejects never reaches the client", async () => {
  const { client, connections, errors, close } = serve(
    async function* (_lastEventId, connection) {
      yield { event: "tick", data: { n: 0 }, id: "0" };
      if (connection === 1) {
        // Past the types.
        yield { event: "tick", data: { n: "one" as never }, id: "1" };
      }
      yield { event: "tick", data: { n: 2 }, id: "2" };
    },
  );
  try {
    const seen: unknown[] = [];
    for await (
      const event of client.ticks.subscribe({ reconnectDelay: 5 })
    ) {
      seen.push(event.data.n);
    }

    // The bad event was not sent; the client reconnected after event 0.
    assertEquals(seen.includes("one"), false);
    assertEquals(seen, [0, 0, 2]);
    assertEquals(connections, [undefined, "0"]);
    assertEquals(errors.length, 1);
  } finally {
    await close();
  }
});

Deno.test("E2E SSE: a handler that returns ends the subscription normally", async () => {
  const { client, connections, errors, close } = serve(
    async function* () {
      yield { event: "tick", data: { n: 0 } };
      yield { event: "tick", data: { n: 1 } };
    },
  );
  try {
    const seen: number[] = [];
    for await (const event of client.ticks.subscribe()) seen.push(event.data.n);
    assertEquals(seen, [0, 1]);
    // One connection: a normal end is not retried.
    assertEquals(connections.length, 1);
    assertEquals(errors, []);
  } finally {
    await close();
  }
});

import { z } from "zod";
import { createApiHandlers, sseEndpoint } from "@/integrations/fetch.ts";

export const handler = createApiHandlers({
  // A stream of `count` ticks, then `done`.
  GET: sseEndpoint({
    query: z.object({
      count: z.coerce.number().int().min(0).default(2),
      // The tick before which a first connection fails.
      failAt: z.coerce.number().int().optional(),
      // The tick in whose place the handler yields an event its schema
      // rejects.
      badAt: z.coerce.number().int().optional(),
      // Milliseconds to wait before the first event.
      pause: z.coerce.number().int().optional(),
    }),
    events: {
      tick: z.object({ n: z.number().int() }),
      done: z.object({ total: z.number().int() }),
    },
    keepAlive: 40,
    async *handler(_request, { query, lastEventId }) {
      if (query.pause !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, query.pause));
      }
      // A client that reconnects continues after the event it has.
      const from = lastEventId === undefined ? 0 : Number(lastEventId) + 1;
      for (let n = from; n < query.count; n++) {
        if (lastEventId === undefined && n === query.failAt) {
          throw new Error("backend went away");
        }
        if (n === query.badAt) {
          yield { event: "tick", data: { n: "not a number" } as never };
        }
        yield { event: "tick", data: { n }, id: String(n) };
      }
      yield { event: "done", data: { total: query.count } };
    },
  }),
});

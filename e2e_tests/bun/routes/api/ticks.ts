import { z } from "zod";
import { createApiHandlers, sseEndpoint } from "@dgellow/typed-endpoints/bun";

export const handler = createApiHandlers({
  GET: sseEndpoint({
    query: z.object({
      count: z.coerce.number().int().default(2),
      // The event before which a first connection fails.
      failAt: z.coerce.number().int().optional(),
    }),
    events: { tick: z.object({ n: z.number() }) },
    async *handler(_req, { query, lastEventId }) {
      // A client that reconnects continues after the event it has.
      const from = lastEventId === undefined ? 0 : Number(lastEventId) + 1;
      for (let n = from; n < query.count; n++) {
        if (lastEventId === undefined && n === query.failAt) {
          throw new Error("backend went away");
        }
        yield { event: "tick", data: { n }, id: String(n) };
      }
    },
  }),
});

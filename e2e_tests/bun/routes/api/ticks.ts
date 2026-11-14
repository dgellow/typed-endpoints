import { z } from "zod";
import { createApiHandlers, sseEndpoint } from "@dgellow/typed-endpoints/bun";

export const handler = createApiHandlers({
  GET: sseEndpoint({
    query: z.object({ count: z.coerce.number().int().default(2) }),
    events: { tick: z.object({ n: z.number() }) },
    async *handler(_req, { query }) {
      for (let n = 0; n < query.count; n++) {
        yield { event: "tick", data: { n } };
      }
    },
  }),
});

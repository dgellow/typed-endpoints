import { z } from "zod";
import { createApiHandlers, sseEndpoint } from "@/integrations/fresh.ts";

// An SSE endpoint whose path ends with a parameter: the generated client
// subscribes with that id.
export const handler = createApiHandlers({
  GET: sseEndpoint({
    params: z.object({ id: z.string() }),
    events: {
      progress: z.object({ percent: z.number() }),
      done: z.object({ finishedAt: z.date() }),
    },
    async *handler() {
      yield { event: "progress", data: { percent: 100 } };
    },
  }),
});

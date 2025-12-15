import { z } from "zod";
import { createApiHandlers, sseEndpoint } from "@/adapters/fresh.ts";

export const handler = createApiHandlers({
  GET: sseEndpoint({
    params: z.object({ id: z.string() }),
    events: {
      progress: z.object({ percent: z.number() }),
      complete: z.object({ result: z.string() }),
      error: z.object({ message: z.string() }),
    },
    async *handler(_ctx, { params }, signal) {
      void params;
      void signal;
      yield { event: "progress", data: { percent: 50 } };
      yield { event: "complete", data: { result: "done" } };
    },
  }),
});

import { z } from "zod";
import { createApiHandlers, sseEndpoint } from "@/integrations/fetch.ts";

export const handler = createApiHandlers({
  // A stream below a parameter.
  GET: sseEndpoint({
    params: z.object({ id: z.string() }),
    events: { seen: z.object({ userId: z.string() }) },
    async *handler(_request, { params }) {
      yield { event: "seen", data: { userId: params.id } };
    },
  }),
});

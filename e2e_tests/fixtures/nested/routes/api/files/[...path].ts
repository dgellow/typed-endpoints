import { z } from "zod";
import { createApiHandlers, endpoint } from "@/integrations/fetch.ts";

export const handler = createApiHandlers({
  // A catch-all: the id of the call spans segments.
  GET: endpoint({
    params: z.object({ path: z.string() }),
    response: z.object({ path: z.string() }),
    handler: (_request, { params }) => ({ path: params.path }),
  }),
});

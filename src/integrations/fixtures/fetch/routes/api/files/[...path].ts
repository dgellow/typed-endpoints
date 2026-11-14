import { z } from "zod";
import { createApiHandlers, endpoint } from "@/integrations/fetch.ts";

export const handler = createApiHandlers({
  GET: endpoint({
    params: z.object({ path: z.string() }),
    handler: (_request, { params }) => Response.json({ path: params.path }),
  }),
});

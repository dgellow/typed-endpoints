import { z } from "zod";
import { createApiHandlers, endpoint } from "@/integrations/fresh.ts";

export const handler = createApiHandlers({
  GET: endpoint({
    params: z.object({ id: z.string() }),
    response: z.array(z.object({ id: z.string() })),
    handler: () => Response.json([]),
  }),
});

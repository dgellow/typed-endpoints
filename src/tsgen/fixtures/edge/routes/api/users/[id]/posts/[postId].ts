import { z } from "zod";
import { createApiHandlers, endpoint } from "@/integrations/fresh.ts";

export const handler = createApiHandlers({
  GET: endpoint({
    params: z.object({ id: z.string(), postId: z.string() }),
    response: z.object({ id: z.string() }),
    handler: () => Response.json({ id: "1" }),
  }),
});

import { z } from "zod";
import { createApiHandlers, endpoint } from "@/integrations/fresh.ts";

export const handler = createApiHandlers({
  // A DELETE that says in its body what to remove, and declares its own
  // 400.
  DELETE: endpoint({
    public: true,
    params: z.object({ id: z.string() }),
    body: z.object({ tags: z.array(z.string()) }),
    responses: {
      200: z.object({ remaining: z.array(z.string()) }),
      400: z.object({ reason: z.string() }),
    },
    handler: () => Response.json({ remaining: [] }),
  }),
});

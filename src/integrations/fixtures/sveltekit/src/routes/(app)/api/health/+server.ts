import { z } from "zod";
import { createApiHandlers, endpoint } from "@/integrations/sveltekit.ts";

export const { GET } = createApiHandlers({
  GET: endpoint({
    public: true,
    response: z.object({ ok: z.boolean() }),
    handler: () => Response.json({ ok: true }),
  }),
});

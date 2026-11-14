import { z } from "zod";
import { createApiHandlers, endpoint } from "@/integrations/fetch.ts";

export const handler = createApiHandlers({
  // Outside /api.
  GET: endpoint({
    response: z.object({ ok: z.boolean() }),
    handler: () => ({ ok: true }),
  }),
});

import { z } from "zod";
import { createApiHandlers, endpoint } from "@/integrations/astro.ts";

export const { GET } = createApiHandlers({
  GET: endpoint({
    public: true,
    params: z.object({ path: z.string() }),
    response: z.object({ path: z.string() }),
    handler: (_context, { params }) => Response.json({ path: params.path }),
  }),
});

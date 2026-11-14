import { z } from "zod";
import { createApiHandlers, endpoint } from "@/integrations/next.ts";

export const { GET } = createApiHandlers({
  GET: endpoint({
    public: true,
    // An optional catch-all: an array of segments, or absent.
    params: z.object({ slug: z.array(z.string()).optional() }),
    response: z.object({ path: z.string() }),
    handler: (_request, { params }) =>
      Response.json({ path: (params.slug ?? []).join("/") }),
  }),
});

import { z } from "zod";
import { createApiHandlers, endpoint } from "@/integrations/fresh.ts";

export const handler = createApiHandlers({
  // No schemas at all: path parameters come from the file name.
  DELETE: endpoint({
    public: true,
    handler: () => new Response(null, { status: 204 }),
  }),
  // A body on GET is not part of the request.
  GET: endpoint({
    public: true,
    body: z.object({ ignored: z.string() }),
    responses: { 200: z.object({ id: z.string() }) },
    handler: () => Response.json({}),
  }),
});

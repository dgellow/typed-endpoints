import { z } from "zod";
import { createApiHandlers, endpoint } from "@dgellow/typed-endpoints/hono";

export const handler = createApiHandlers({
  GET: endpoint({
    params: z.object({ path: z.string() }),
    handler: (_c, { params }) => Response.json({ path: params.path }),
  }),
});

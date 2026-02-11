import { z } from "zod";
import { createApiHandlers, endpoint } from "@/integrations/fresh.ts";

export const handler = createApiHandlers({
  POST: endpoint({
    body: z.object({
      type: z.string(),
      data: z.object({
        id: z.string(),
      }),
    }),
    response: z.object({
      received: z.boolean(),
    }),
    handler: (_ctx, { body: _body }) => {
      return Response.json({ received: true });
    },
  }),
});

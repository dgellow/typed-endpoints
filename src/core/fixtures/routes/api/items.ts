import { z } from "zod";
import { createApiHandlers, endpoint } from "@/integrations/fresh.ts";

const Item = z.object({ id: z.string(), name: z.string() });

export const handler = createApiHandlers({
  GET: endpoint({
    public: true,
    response: z.array(Item),
    handler: () => Response.json([]),
  }),
  POST: endpoint({
    public: true,
    operationId: "createItem",
    body: Item.omit({ id: true }),
    response: Item,
    handler: () => Response.json({}),
  }),
});

import { z } from "zod";
import { createApiHandlers, endpoint } from "@/integrations/fresh.ts";

// Two operations with the same explicit operationId.
export const handler = createApiHandlers({
  POST: endpoint({
    public: true,
    operationId: "duplicateItem",
    response: z.object({ id: z.string() }),
    handler: () => Response.json({}),
  }),
  PUT: endpoint({
    public: true,
    operationId: "duplicateItem",
    response: z.object({ id: z.string() }),
    handler: () => Response.json({}),
  }),
});

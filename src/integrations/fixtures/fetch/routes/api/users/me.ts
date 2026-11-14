import { createApiHandlers, endpoint } from "@/integrations/fetch.ts";

// A static segment wins over the [id] parameter next to it.
export const handler = createApiHandlers({
  GET: endpoint({
    handler: () => Response.json({ id: "me" }),
  }),
});

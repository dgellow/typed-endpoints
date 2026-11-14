import { z } from "zod";
import { createApiHandlers, endpoint } from "@/integrations/fresh.ts";

// The same URL shape as [id].ts: both are `users.retrieve` for the client
// and `usersRetrieve` in the route table.
export const handler = createApiHandlers({
  GET: endpoint({
    response: z.object({ slug: z.string() }),
    handler: () => Response.json({}),
  }),
});

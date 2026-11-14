import { z } from "zod";
import { createApiHandlers, endpoint } from "@/integrations/fresh.ts";

const User = z.object({ id: z.string(), name: z.string() });

// PUT and PATCH both map to the client method `update` and to the derived
// route id `usersUpdate`.
export const handler = createApiHandlers({
  PUT: endpoint({
    body: User,
    response: User,
    handler: () => Response.json({}),
  }),
  PATCH: endpoint({
    body: User.partial(),
    response: User,
    handler: () => Response.json({}),
  }),
});

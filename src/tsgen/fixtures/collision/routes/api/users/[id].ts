import { z } from "zod";
import { createApiHandlers, endpoint } from "@/integrations/fresh.ts";

const User = z.object({ id: z.string(), name: z.string() });

// PUT next to PATCH: `replace` and `update` for the client, `usersReplace`
// and `usersUpdate` in the route table. GET collides with [slug].ts.
export const handler = createApiHandlers({
  GET: endpoint({
    response: User,
    handler: () => Response.json({}),
  }),
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

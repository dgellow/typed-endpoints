import { z } from "zod";
import { createApiHandlers, endpoint } from "@/integrations/next.ts";
import { NewUser, User, USERS } from "../../../../schemas.ts";

export const { GET, POST } = createApiHandlers({
  GET: endpoint({
    public: true,
    query: z.object({ limit: z.coerce.number().int().default(10) }),
    response: z.array(User),
    handler: (_request, { query }) =>
      Response.json(USERS.slice(0, query.limit)),
  }),
  POST: endpoint({
    public: true,
    body: NewUser,
    response: User,
    handler: (_request, { body }) => Response.json({ id: "3", ...body }),
  }),
});

import { z } from "zod";
import { createApiHandlers, endpoint } from "@/integrations/fetch.ts";
import { NewUser, User, USERS } from "../../../schemas.ts";

export const handler = createApiHandlers({
  GET: endpoint({
    public: true,
    response: z.array(User),
    handler: () => Response.json(USERS),
  }),
  POST: endpoint({
    public: true,
    body: NewUser,
    response: User,
    handler: (_request, { body }) => Response.json({ id: "3", ...body }),
  }),
});

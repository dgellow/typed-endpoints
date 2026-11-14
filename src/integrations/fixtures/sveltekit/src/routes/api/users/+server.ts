import { createApiHandlers, endpoint } from "@/integrations/sveltekit.ts";
import { NewUser, User, USERS } from "../../../../../schemas.ts";
import { z } from "zod";

export const { GET, POST } = createApiHandlers({
  GET: endpoint({
    public: true,
    response: z.array(User),
    handler: () => Response.json(USERS),
  }),
  POST: endpoint({
    public: true,
    body: NewUser,
    response: User,
    handler: (_event, { body }) => Response.json({ id: "3", ...body }),
  }),
});

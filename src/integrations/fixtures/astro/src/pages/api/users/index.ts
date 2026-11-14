import { z } from "zod";
import { createApiHandlers, endpoint } from "@/integrations/astro.ts";
import { User, USERS } from "../../../../../schemas.ts";

export const prerender = false;

export const { GET } = createApiHandlers({
  GET: endpoint({
    public: true,
    response: z.array(User),
    handler: () => Response.json(USERS),
  }),
});

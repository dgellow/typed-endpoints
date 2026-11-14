import { createApiHandlers, endpoint } from "@/integrations/astro.ts";
import { findUser, IdParams, User } from "../../../../../schemas.ts";

export const { GET } = createApiHandlers({
  GET: endpoint({
    public: true,
    params: IdParams,
    response: User,
    handler: (_context, { params }) => findUser(params.id),
  }),
});

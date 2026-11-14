import { createApiHandlers, endpoint } from "@/integrations/fetch.ts";
import { findUser, IdParams, User } from "../../../../schemas.ts";

export const handler = createApiHandlers({
  GET: endpoint({
    public: true,
    params: IdParams,
    response: User,
    handler: (_request, { params }) => findUser(params.id),
  }),
});

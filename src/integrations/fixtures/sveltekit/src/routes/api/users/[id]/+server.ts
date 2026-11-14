import { createApiHandlers, endpoint } from "@/integrations/sveltekit.ts";
import { findUser, IdParams, User } from "../../../../../../schemas.ts";

export const { GET } = createApiHandlers({
  GET: endpoint({
    public: true,
    params: IdParams,
    response: User,
    handler: (_event, { params }) => findUser(params.id),
  }),
});

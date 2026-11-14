import { createApiHandlers, endpoint } from "@/integrations/next.ts";
import { findUser, IdParams, User } from "../../../../../schemas.ts";

// Route segment config: an export that is not a method handler.
export const dynamic = "force-dynamic";

export const { GET, DELETE } = createApiHandlers({
  GET: endpoint({
    public: true,
    params: IdParams,
    response: User,
    handler: (_request, { params }) => findUser(params.id),
  }),
  DELETE: endpoint({
    public: true,
    params: IdParams,
    handler: () => new Response(null, { status: 204 }),
  }),
});

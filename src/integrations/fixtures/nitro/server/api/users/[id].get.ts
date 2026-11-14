import { createHandler, endpoint } from "@/integrations/nitro.ts";
import { findUser, IdParams, User } from "../../../../schemas.ts";

export default createHandler(endpoint({
  public: true,
  params: IdParams,
  response: User,
  handler: (_event, { params }) => findUser(params.id),
}));

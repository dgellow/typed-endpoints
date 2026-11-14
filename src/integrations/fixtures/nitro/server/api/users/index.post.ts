import { createHandler, endpoint } from "@/integrations/nitro.ts";
import { NewUser, User } from "../../../../schemas.ts";

export default createHandler(endpoint({
  public: true,
  body: NewUser,
  response: User,
  handler: (_event, { body }) => Response.json({ id: "3", ...body }),
}));

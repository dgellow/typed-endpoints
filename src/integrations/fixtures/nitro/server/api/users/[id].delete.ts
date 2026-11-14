import { createHandler, endpoint } from "@/integrations/nitro.ts";
import { IdParams } from "../../../../schemas.ts";

export default createHandler(endpoint({
  public: true,
  params: IdParams,
  handler: () => new Response(null, { status: 204 }),
}));

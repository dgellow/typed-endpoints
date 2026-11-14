import { z } from "zod";
import { createHandler, endpoint } from "@/integrations/nitro.ts";

export default createHandler(endpoint({
  public: true,
  response: z.object({ ok: z.boolean() }),
  handler: () => Response.json({ ok: true }),
}));

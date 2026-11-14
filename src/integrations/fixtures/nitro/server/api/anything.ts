import { z } from "zod";
import { createHandler, endpoint } from "@/integrations/nitro.ts";

// No method in the file name: answers every method, and is left out of
// generated output.
export default createHandler(endpoint({
  public: true,
  response: z.object({ method: z.string() }),
  handler: (event) => Response.json({ method: event.req.method }),
}));

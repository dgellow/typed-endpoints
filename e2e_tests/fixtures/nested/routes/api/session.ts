import { z } from "zod";
import { createApiHandlers, endpoint } from "@/integrations/fetch.ts";

export const handler = createApiHandlers({
  // A resource without an id: its methods take none.
  PUT: endpoint({
    body: z.object({ theme: z.string() }),
    response: z.object({ theme: z.string() }),
    handler: (_request, { body }) => body,
  }),
  DELETE: endpoint({
    response: z.object({ signedOut: z.boolean() }),
    handler: () => ({ signedOut: true }),
  }),
});

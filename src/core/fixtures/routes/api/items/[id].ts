import { z } from "zod";
import { createApiHandlers, endpoint } from "@/integrations/fresh.ts";

const Item = z.object({ id: z.string(), name: z.string() });

export const handler = createApiHandlers({
  GET: endpoint({
    public: true,
    params: z.object({ id: z.string() }),
    response: Item,
    handler: () => Response.json({}),
  }),
  // PUT and PATCH derive the same operationId.
  PUT: endpoint({
    public: true,
    body: Item,
    handler: () => Response.json({}),
  }),
  PATCH: endpoint({
    public: true,
    body: Item.partial(),
    handler: () => Response.json({}),
  }),
  // Not public: not in the spec, so it cannot collide.
  DELETE: endpoint({
    handler: () => new Response(null, { status: 204 }),
  }),
});

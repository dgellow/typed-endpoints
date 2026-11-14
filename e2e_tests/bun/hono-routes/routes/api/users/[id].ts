import { z } from "zod";
import { createApiHandlers, endpoint } from "@dgellow/typed-endpoints/hono";

export const handler = createApiHandlers({
  GET: endpoint({
    public: true,
    params: z.object({ id: z.string().regex(/^\d+$/) }),
    response: z.object({ id: z.string(), via: z.string() }),
    // `c` is Hono's context: its response helpers work.
    handler: (c, { params }) =>
      (c as unknown as { json: (v: unknown) => Response }).json({
        id: params.id,
        via: "hono",
      }),
  }),
  PUT: endpoint({
    params: z.object({ id: z.string() }),
    body: z.object({ name: z.string() }),
    handler: (_c, { params, body }) =>
      Response.json({ id: params.id, name: body.name }),
  }),
});

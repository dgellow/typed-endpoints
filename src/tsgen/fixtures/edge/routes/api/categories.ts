import { z } from "zod";
import { createApiHandlers, endpoint } from "@/integrations/fresh.ts";

// Printed while the module is imported. Generation must not mistake it for
// its own output.
console.log('{"noise": "printed by a route module"}');

const Category = z.object({
  name: z.string().describe("Display name"),
  createdAt: z.date(),
  "sort-key": z.number(),
  get children() {
    return z.array(Category);
  },
});

export const handler = createApiHandlers({
  GET: endpoint({
    query: z.object({
      depth: z.coerce.number().int().default(1),
      tag: z.array(z.string()).optional(),
    }),
    response: z.array(Category),
    handler: () => Response.json([]),
  }),
  POST: endpoint({
    body: z.object({
      name: z.string(),
      kind: z.enum(["leaf", "branch"]).default("leaf"),
      label: z.literal('the "root"').optional(),
    }),
    response: Category,
    handler: () => Response.json({}),
  }),
});

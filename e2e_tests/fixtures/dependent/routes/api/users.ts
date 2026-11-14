import { z } from "zod";
import { createApiHandlers, endpoint } from "@/integrations/fresh.ts";
import { fieldsOf, projection } from "@/core/dependent.ts";
import { User, USERS } from "../../schemas.ts";

export const handler = createApiHandlers({
  // Sparse fieldsets: ?fields=id&fields=name returns objects with two keys.
  GET: endpoint({
    public: true,
    query: z.object({
      fields: fieldsOf(User),
      limit: z.coerce.number().int().min(1).default(10),
    }),
    response: z.object({
      data: z.array(projection(User, "fields")),
      total: z.number(),
    }),
    // Complete objects: the response schema cuts them down to `fields`.
    handler: (_ctx, { query }) => ({
      data: USERS.slice(0, query.limit),
      total: USERS.length,
    }),
  }),
});

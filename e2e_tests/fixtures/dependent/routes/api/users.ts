import { z } from "zod";
import { createApiHandlers, endpoint } from "@/integrations/fresh.ts";
import { fieldsOf, projection, select } from "@/core/dependent.ts";
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
    handler: (_ctx, { query }) =>
      Response.json({
        data: USERS.slice(0, query.limit).map((user) =>
          select(user, query.fields)
        ),
        total: USERS.length,
      }),
  }),
});

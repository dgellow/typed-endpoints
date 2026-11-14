import { z } from "zod";
import { createApiHandlers, endpoint } from "@/integrations/fresh.ts";
import { selection, selectOf } from "@/core/selection.ts";
import { Post, POSTS } from "../../schemas.ts";

export const handler = createApiHandlers({
  // ?select=id,author(name),comments(text,by(name))
  GET: endpoint({
    public: true,
    query: z.object({
      select: selectOf(Post),
      limit: z.coerce.number().int().min(1).default(10),
    }),
    response: z.object({
      data: z.array(selection(Post, "select")),
      total: z.number(),
    }),
    // Complete objects: the response schema cuts them down to `select`.
    handler: (_ctx, { query }) => ({
      data: POSTS.slice(0, query.limit),
      total: POSTS.length,
    }),
  }),
});

import { z } from "zod";
import { createApiHandlers, endpoint } from "@/integrations/fetch.ts";

const Post = z.object({
  id: z.string(),
  userId: z.string(),
  title: z.string(),
});

export const handler = createApiHandlers({
  // A collection below a parameter: the parameter is not a trailing id.
  GET: endpoint({
    params: z.object({ id: z.string() }),
    query: z.object({ limit: z.coerce.number().int().default(2) }),
    response: z.array(Post),
    handler: (_request, { params, query }) =>
      Array.from({ length: query.limit }, (_, i) => ({
        id: String(i + 1),
        userId: params.id,
        title: `Post ${i + 1}`,
      })),
  }),
  POST: endpoint({
    params: z.object({ id: z.string() }),
    body: z.object({ title: z.string() }),
    response: Post,
    handler: (_request, { params, body }) => ({
      id: "new",
      userId: params.id,
      title: body.title,
    }),
  }),
});

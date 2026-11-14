import { z } from "zod";
import { createApiHandlers, endpoint } from "@/integrations/fetch.ts";

const Params = z.object({ id: z.string(), postId: z.string() });
const Post = z.object({
  id: z.string(),
  userId: z.string(),
  title: z.string(),
});
const Result = z.object({ via: z.string(), post: Post });

const post = (params: z.output<typeof Params>, title: string) => ({
  id: params.postId,
  userId: params.id,
  title,
});

export const handler = createApiHandlers({
  // Two parameters: the trailing one is the id of the call.
  GET: endpoint({
    params: Params,
    response: Post,
    handler: (_request, { params }) => post(params, "stored"),
  }),
  // PUT next to PATCH: `replace` and `update` in the client.
  PUT: endpoint({
    params: Params,
    body: z.object({ title: z.string() }),
    response: Result,
    handler: (_request, { params, body }) => ({
      via: "PUT",
      post: post(params, body.title),
    }),
  }),
  PATCH: endpoint({
    params: Params,
    body: z.object({ title: z.string().optional() }),
    response: Result,
    handler: (_request, { params, body }) => ({
      via: "PATCH",
      post: post(params, body.title ?? "stored"),
    }),
  }),
  DELETE: endpoint({
    params: Params,
    response: z.object({ deleted: z.string() }),
    handler: (_request, { params }) => ({
      deleted: `${params.id}/${params.postId}`,
    }),
  }),
});

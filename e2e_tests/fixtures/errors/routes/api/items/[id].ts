import { z } from "zod";
import { createApiHandlers, endpoint } from "@/integrations/fresh.ts";

const Item = z.object({
  id: z.string(),
  title: z.string(),
  version: z.number(),
});
const NotFound = z.object({ error: z.literal("not_found"), id: z.string() });
const Conflict = z.object({
  error: z.literal("conflict"),
  current: z.number(),
});
const Params = z.object({ id: z.string() });

const store = new Map<string, z.output<typeof Item>>([
  ["a", { id: "a", title: "First", version: 1 }],
]);

const notFound = (id: string) =>
  Response.json({ error: "not_found", id }, { status: 404 });

export const handler = createApiHandlers({
  GET: endpoint({
    public: true,
    params: Params,
    response: Item,
    responses: { 404: NotFound },
    handler: (_ctx, { params }) => store.get(params.id) ?? notFound(params.id),
  }),
  // Optimistic concurrency: the version sent has to be the current one.
  PUT: endpoint({
    public: true,
    params: Params,
    body: z.object({ title: z.string(), version: z.number() }),
    response: Item,
    responses: { 404: NotFound, 409: { schema: Conflict, name: "Conflict" } },
    handler: (_ctx, { params, body }) => {
      const item = store.get(params.id);
      if (!item) return notFound(params.id);
      if (body.version === 0) {
        // A status the endpoint does not declare.
        return Response.json({ error: "teapot" }, { status: 418 });
      }
      if (item.version !== body.version) {
        return Response.json(
          { error: "conflict", current: item.version },
          { status: 409 },
        );
      }
      const next = { ...item, title: body.title, version: item.version + 1 };
      store.set(item.id, next);
      return next;
    },
  }),
  DELETE: endpoint({
    public: true,
    params: Params,
    responses: { 404: NotFound },
    handler: (_ctx, { params }) =>
      store.has(params.id)
        ? new Response(null, { status: 204 })
        : notFound(params.id),
  }),
});

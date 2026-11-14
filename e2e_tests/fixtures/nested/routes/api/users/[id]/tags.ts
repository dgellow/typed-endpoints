import { z } from "zod";
import { createApiHandlers, endpoint } from "@/integrations/fetch.ts";

const tags = new Map<string, string[]>([["42", ["a", "b", "c"]]]);

export const handler = createApiHandlers({
  // A DELETE that says in its body what to remove.
  DELETE: endpoint({
    params: z.object({ id: z.string() }),
    body: z.object({ tags: z.array(z.string()).min(1) }),
    response: z.object({ remaining: z.array(z.string()) }),
    handler: (_request, { params, body }) => {
      const remaining = (tags.get(params.id) ?? []).filter((tag) =>
        !body.tags.includes(tag)
      );
      tags.set(params.id, remaining);
      return { remaining };
    },
  }),
});

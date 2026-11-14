import { z } from "zod";
import { createApiHandlers, endpoint } from "@/integrations/fetch.ts";

interface Tree {
  name: string;
  children: Tree[];
}

// A schema that refers to itself.
const Tree: z.ZodType<Tree> = z.object({
  name: z.string(),
  get children() {
    return z.array(Tree);
  },
});

const depth = (tree: Tree): number =>
  1 + Math.max(0, ...tree.children.map(depth));

export const handler = createApiHandlers({
  POST: endpoint({
    body: Tree,
    response: z.object({ depth: z.number().int(), root: Tree }),
    handler: (_request, { body }) => ({ depth: depth(body), root: body }),
  }),
});

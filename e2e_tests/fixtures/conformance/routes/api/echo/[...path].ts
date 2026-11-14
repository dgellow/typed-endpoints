import { z } from "zod";
import { createApiHandlers, endpoint } from "@/integrations/fetch.ts";

export const handler = createApiHandlers({
  // A catch-all: the parameter keeps its slashes.
  GET: endpoint({
    params: z.object({ path: z.string() }),
    response: z.object({ path: z.string(), segments: z.array(z.string()) }),
    handler: (_request, { params }) => {
      // A failure that is not part of the contract.
      if (params.path === "fail") throw new Error("the backend is down");
      return { path: params.path, segments: params.path.split("/") };
    },
  }),
});

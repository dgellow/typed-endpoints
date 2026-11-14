import { z } from "zod";
import { createApiHandlers, endpoint } from "@/integrations/fresh.ts";
import { cursor } from "@/pagination/index.ts";

const Report = z.object({ id: z.string(), title: z.string() });
const Problem = z.object({ message: z.string() });

export const handler = createApiHandlers({
  // Paginated list: query parameters and x-pagination.
  GET: endpoint({
    public: true,
    summary: "List reports",
    description: "Reports, newest first.",
    tags: ["reports"],
    ...cursor.paginated({
      item: Report,
      names: { items: "data", cursor: "next" },
      extraQuery: { tag: z.array(z.string()).optional() },
    }),
    handler: () => Response.json({ data: [] }),
  }),
  // Named body and response components, extra status codes.
  POST: endpoint({
    public: true,
    body: Report.omit({ id: true }),
    bodyName: "NewReport",
    response: Report,
    responseName: "Report",
    responses: {
      409: Problem,
      422: { schema: Problem, name: "ValidationProblem" },
    },
    handler: () => Response.json({}),
  }),
});

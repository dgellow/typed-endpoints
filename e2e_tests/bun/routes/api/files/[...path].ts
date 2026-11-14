import { createApiHandlers, endpoint } from "@dgellow/typed-endpoints/bun";

export const handler = createApiHandlers({
  // Bun's wildcard has no parameter name; the path is in the URL.
  GET: endpoint({
    handler: (req) =>
      Response.json({
        path: new URL(req.url).pathname.slice("/api/files/".length),
      }),
  }),
});

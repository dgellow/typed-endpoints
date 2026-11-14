import { z } from "zod";
import { createApiHandlers, endpoint } from "@dgellow/typed-endpoints/bun";
import { fieldsOf, projection, select } from "@dgellow/typed-endpoints";

export const User = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
});

export const USERS: z.output<typeof User>[] = [
  { id: "1", name: "Ada", email: "ada@example.test" },
  { id: "2", name: "Grace", email: "grace@example.test" },
];

export const handler = createApiHandlers({
  GET: endpoint({
    public: true,
    query: z.object({
      fields: fieldsOf(User),
      tag: z.array(z.string()).optional(),
    }),
    response: z.object({ data: z.array(projection(User, "fields")) }),
    handler: (_req, { query }) =>
      Response.json({ data: USERS.map((u) => select(u, query.fields)) }),
  }),
  POST: endpoint({
    public: true,
    body: User.omit({ id: true }),
    response: User,
    handler: (_req, { body }) =>
      Response.json({ id: String(USERS.length + 1), ...body }),
  }),
});

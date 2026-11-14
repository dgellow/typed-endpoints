import { z } from "zod";
import { createApiHandlers, endpoint } from "@dgellow/typed-endpoints/bun";
import { User, USERS } from "../users.ts";

export const handler = createApiHandlers({
  GET: endpoint({
    public: true,
    params: z.object({ id: z.string().regex(/^\d+$/) }),
    response: User,
    handler: (req, { params }) => {
      const user = USERS.find((u) => u.id === params.id);
      // The handler receives Bun's request: params are on it as well.
      if (req.params?.id !== params.id) throw new Error("params mismatch");
      return user
        ? Response.json(user)
        : Response.json({ error: "not found" }, { status: 404 });
    },
  }),
});

import { z } from "zod";
import { createApiHandlers, endpoint } from "@/integrations/fresh.ts";
import { expansion, relationsOf } from "@/core/dependent.ts";
import { TEAM, User, userRelations, USERS } from "../../../schemas.ts";

export const handler = createApiHandlers({
  // Expansions: ?expand=team adds the team to the user.
  GET: endpoint({
    public: true,
    params: z.object({ id: z.string() }),
    query: z.object({ expand: relationsOf(userRelations) }),
    response: expansion(User, "expand", userRelations),
    handler: (_ctx, { params, query }) => {
      const user = USERS.find((u) => u.id === params.id);
      if (!user) return Response.json({ error: "not found" }, { status: 404 });
      const expand = query.expand ?? [];
      return Response.json({
        ...user,
        ...(expand.includes("team") && { team: TEAM }),
        ...(expand.includes("manager") && { manager: USERS[0] }),
      });
    },
  }),
});

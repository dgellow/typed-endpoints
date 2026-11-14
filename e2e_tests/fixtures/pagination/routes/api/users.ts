import { createApiHandlers, endpoint } from "@/integrations/fresh.ts";
import { fieldsOf, projection } from "@/core/dependent.ts";
import { cursor } from "@/pagination/index.ts";
import { Item, ITEMS } from "../../data.ts";

// Cursor style, with renamed fields, and items the request can cut down.
const users = cursor.paginated({
  item: projection(Item, "fields"),
  names: { items: "data", cursor: "nextCursor" },
  defaultLimit: 3,
  extraQuery: { fields: fieldsOf(Item) },
});

export const handler = createApiHandlers({
  GET: endpoint({
    ...users,
    public: true,
    handler: (_ctx, { query }) => {
      const start = query.cursor ? Number(query.cursor) : 0;
      const end = start + query.limit;
      return users.page({
        items: ITEMS.slice(start, end),
        cursor: end < ITEMS.length ? String(end) : null,
      });
    },
  }),
});

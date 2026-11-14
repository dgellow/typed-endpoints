import { createApiHandlers, endpoint } from "@/integrations/fresh.ts";
import { cursorId } from "@/pagination/index.ts";
import { Item, ITEMS } from "../../data.ts";

// Cursor-id style: the page after the item with the given id.
const events = cursorId.paginated({ item: Item, defaultLimit: 3 });

export const handler = createApiHandlers({
  GET: endpoint({
    ...events,
    public: true,
    handler: (_ctx, { query }) => {
      const start = query.after
        ? ITEMS.findIndex((item) => item.id === query.after) + 1
        : 0;
      return events.page({ items: ITEMS.slice(start, start + query.limit) });
    },
  }),
});

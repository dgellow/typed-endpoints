import { createApiHandlers, endpoint } from "@/integrations/fresh.ts";
import { offset } from "@/pagination/index.ts";
import { Item, ITEMS } from "../../data.ts";

// Offset style.
const orders = offset.paginated({ item: Item, defaultLimit: 3 });

export const handler = createApiHandlers({
  GET: endpoint({
    ...orders,
    public: true,
    handler: (_ctx, { query }) =>
      orders.page({
        items: ITEMS.slice(query.offset, query.offset + query.limit),
        total: ITEMS.length,
      }),
  }),
});

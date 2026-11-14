import { z } from "zod";
import { createApiHandlers, endpoint } from "@/integrations/fresh.ts";
import { page } from "@/pagination/index.ts";
import { Item, ITEMS } from "../../data.ts";

// Page-number style, with a page count and an extra response field.
const products = page.paginated({
  item: Item,
  names: { totalPages: "pages" },
  defaultPerPage: 3,
  extraResponse: { currency: z.string() },
});

export const handler = createApiHandlers({
  GET: endpoint({
    ...products,
    public: true,
    handler: (_ctx, { query }) => {
      const start = (query.page - 1) * query.perPage;
      return products.page({
        items: ITEMS.slice(start, start + query.perPage),
        totalPages: Math.ceil(ITEMS.length / query.perPage),
        extra: { currency: "EUR" },
      });
    },
  }),
});

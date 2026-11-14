import { createApiHandlers, endpoint } from "@/integrations/fresh.ts";
import { url } from "@/pagination/index.ts";
import { Item, ITEMS } from "../../data.ts";

// URL style: the response says where the next page is. Nested fields.
const repos = url.paginated({
  item: Item,
  names: { items: "data.repos", nextUrl: "links.next", prevUrl: "links.prev" },
});

const SIZE = 3;

export const handler = createApiHandlers({
  GET: endpoint({
    ...repos,
    public: true,
    handler: (ctx) => {
      const here = new URL(ctx.req.url);
      const number = Number(here.searchParams.get("page") ?? 1);
      const start = (number - 1) * SIZE;
      const link = (page: number) => `${here.pathname}?page=${page}`;
      return repos.page({
        items: ITEMS.slice(start, start + SIZE),
        // A relative URL: the client resolves it against its base URL.
        next: start + SIZE < ITEMS.length ? link(number + 1) : null,
        prev: number > 1 ? link(number - 1) : null,
      });
    },
  }),
});

// Auto-generated API types for use with createClient()
// Do not edit manually

import type { Dependent, Projection } from "@/client/index.ts";

export interface Api {
  events: {
    list: {
      path: "/api/events";
      query: { after?: string | undefined; limit?: number | undefined; };
      response: { items: { id: string; name: string; }[]; };
      pagination: {
        style: "cursorId";
        items: "items";
        limitParam: "limit";
        cursorIdParam: "after";
        idField: "id";
      };
    };
  };
  orders: {
    list: {
      path: "/api/orders";
      query: { offset?: number | undefined; limit?: number | undefined; };
      response: { items: { id: string; name: string; }[]; total: number; };
      pagination: {
        style: "offset";
        items: "items";
        limitParam: "limit";
        total: "total";
        offsetParam: "offset";
      };
    };
  };
  products: {
    list: {
      path: "/api/products";
      query: { page?: number | undefined; perPage?: number | undefined; };
      response: { items: { id: string; name: string; }[]; pages: number; currency: string; };
      pagination: {
        style: "page";
        items: "items";
        pageParam: "page";
        perPageParam: "perPage";
        totalPages: "pages";
      };
    };
  };
  repos: {
    list: {
      path: "/api/repos";
      response: { data: { repos: { id: string; name: string; }[]; }; links: { next?: string | undefined; prev?: string | undefined; }; };
      pagination: {
        style: "url";
        items: "data.repos";
        nextUrl: "links.next";
        prevUrl: "links.prev";
      };
    };
  };
  users: {
    list: {
      path: "/api/users";
      query: { cursor?: string | undefined; limit?: number | undefined; fields?: ("id" | "name")[] | undefined; };
      response: { data: Dependent<Projection<{ id: string; name: string; }, "fields">, { id?: string | undefined; name?: string | undefined; }>[]; nextCursor?: string | undefined; };
      dependent: true;
      pagination: {
        style: "cursor";
        items: "data";
        limitParam: "limit";
        cursor: "nextCursor";
        cursorParam: "cursor";
      };
    };
  };
}

/** Pass to `createClient<Api>({ baseUrl, routes })`. */
export const routes = {
  "events.list": { method: "GET", path: "/api/events", pagination: { style: "cursorId", items: "items", limitParam: "limit", cursorIdParam: "after", idField: "id" } },
  "orders.list": { method: "GET", path: "/api/orders", pagination: { style: "offset", items: "items", limitParam: "limit", total: "total", offsetParam: "offset" } },
  "products.list": { method: "GET", path: "/api/products", pagination: { style: "page", items: "items", pageParam: "page", perPageParam: "perPage", totalPages: "pages" } },
  "repos.list": { method: "GET", path: "/api/repos", pagination: { style: "url", items: "data.repos", nextUrl: "links.next", prevUrl: "links.prev" } },
  "users.list": { method: "GET", path: "/api/users", pagination: { style: "cursor", items: "data", limitParam: "limit", cursor: "nextCursor", cursorParam: "cursor" } },
} as const;

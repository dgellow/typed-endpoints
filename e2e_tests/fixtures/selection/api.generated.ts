// Auto-generated API types for use with createClient()
// Do not edit manually

import type { Dependent, Selection } from "@/client/index.ts";

export interface Api {
  posts: {
    list: {
      path: "/api/posts";
      query: { select?: string | undefined; limit?: number | undefined; };
      response: { data: Dependent<Selection<{ id: string; title: string; body?: string | undefined; author: { id: string; name: string; email: string; }; reviewer: { id: string; name: string; email: string; } | null; tags: string[]; comments: { id: string; text: string; by: { id: string; name: string; email: string; }; }[]; }, "select">, { id?: string | undefined; title?: string | undefined; body?: string | undefined; author?: { id?: string | undefined; name?: string | undefined; email?: string | undefined; } | undefined; reviewer?: { id?: string | undefined; name?: string | undefined; email?: string | undefined; } | null | undefined; tags?: string[] | undefined; comments?: { id?: string | undefined; text?: string | undefined; by?: { id?: string | undefined; name?: string | undefined; email?: string | undefined; } | undefined; }[] | undefined; }>[]; total: number; };
      dependent: true;
    };
  };
}

/** Pass to `createClient<Api>({ baseUrl, routes })`. */
export const routes = {
  "posts.list": { method: "GET", path: "/api/posts" },
} as const;

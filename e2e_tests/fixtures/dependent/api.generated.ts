// Auto-generated API types for use with createClient()
// Do not edit manually

import type { Dependent, Expansion, Projection } from "@/client/index.ts";

export interface Api {
  users: {
    list: {
      path: "/api/users";
      query: { fields?: ("id" | "name" | "email" | "age")[] | undefined; limit?: number | undefined; };
      response: { data: Dependent<Projection<{ id: string; name: string; email: string; age?: number | undefined; }, "fields">, { id?: string | undefined; name?: string | undefined; email?: string | undefined; age?: number | undefined; }>[]; total: number; };
      dependent: true;
    };
    retrieve: {
      path: "/api/users/{id}";
      params: { id: string; };
      query: { expand?: ("team" | "manager")[] | undefined; };
      response: Dependent<Expansion<{ id: string; name: string; email: string; age?: number | undefined; }, "expand", { team: { id: string; title: string; }; manager: { id: string; name: string; email: string; age?: number | undefined; }; }>, { id: string; name: string; email: string; age?: number | undefined; team?: { id: string; title: string; } | undefined; manager?: { id: string; name: string; email: string; age?: number | undefined; } | undefined; }>;
      dependent: true;
    };
  };
}

/** Pass to `createClient<Api>({ baseUrl, routes })`. */
export const routes = {
  "users.list": { method: "GET", path: "/api/users" },
  "users.retrieve": { method: "GET", path: "/api/users/{id}" },
} as const;

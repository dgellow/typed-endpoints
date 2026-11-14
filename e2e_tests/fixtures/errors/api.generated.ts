// Auto-generated API types for use with createClient()
// Do not edit manually

export interface Api {
  items: {
    retrieve: {
      path: "/api/items/{id}";
      params: { id: string; };
      response: { id: string; title: string; version: number; };
      errors: { 404: { error: "not_found"; id: string; }; };
    };
    update: {
      path: "/api/items/{id}";
      params: { id: string; };
      body: { title: string; version: number; };
      response: { id: string; title: string; version: number; };
      errors: { 404: { error: "not_found"; id: string; }; 409: { error: "conflict"; current: number; }; };
    };
    delete: {
      path: "/api/items/{id}";
      params: { id: string; };
      errors: { 404: { error: "not_found"; id: string; }; };
    };
  };
}

/** Pass to `createClient<Api>({ baseUrl, routes })`. */
export const routes = {
  "items.retrieve": { method: "GET", path: "/api/items/{id}", errors: [404] },
  "items.update": { method: "PUT", path: "/api/items/{id}", errors: [404, 409] },
  "items.delete": { method: "DELETE", path: "/api/items/{id}", errors: [404] },
} as const;

// Auto-generated API types for use with createClient()
// Do not edit manually

// Named types
export type RecursiveInput = { name: string; children: RecursiveInput[]; };
export type Recursive = { name: string; children: Recursive[]; };

export interface Api {
  echo: {
    retrieve: {
      path: "/api/echo/{+path}";
      params: { path: string; };
      response: { path: string; segments: string[]; };
    };
  };
  notes: {
    list: {
      path: "/api/notes";
      query: { cursor?: string | undefined; limit?: number | undefined; tag?: string[] | undefined; };
      response: { items: { title: string; tags: string[]; pinned?: boolean | undefined; id: string; likes: number; }[]; cursor?: string | undefined; };
      pagination: {
        style: "cursor";
        items: "items";
        limitParam: "limit";
        cursor: "cursor";
        cursorParam: "cursor";
      };
    };
    create: {
      path: "/api/notes";
      body: { title: string; tags: string[]; pinned?: boolean | undefined; };
      response: { title: string; tags: string[]; pinned?: boolean | undefined; id: string; likes: number; };
      errors: { 409: { error: "conflict"; title: string; }; };
    };
    retrieve: {
      path: "/api/notes/{id}";
      params: { id: string; };
      response: { title: string; tags: string[]; pinned?: boolean | undefined; id: string; likes: number; };
      errors: { 404: { error: "not_found"; id: string; }; };
    };
    update: {
      path: "/api/notes/{id}";
      params: { id: string; };
      body: { title: string; tags: string[]; pinned?: boolean | undefined; };
      response: { title: string; tags: string[]; pinned?: boolean | undefined; id: string; likes: number; };
    };
    delete: {
      path: "/api/notes/{id}";
      params: { id: string; };
      body: { reason: string; };
      response: { deleted: true; reason: string; };
      errors: { 404: { error: "not_found"; id: string; }; };
    };
  };
  shapes: {
    create: {
      path: "/api/shapes";
      body: { shape: { kind: "circle"; radius: number; } | { kind: "rect"; width: number; height: number; }; from: string; meta: { "data-id": string; class?: string | undefined; }; unit?: "mm" | "cm" | undefined; note: string | null; };
      response: { area: number; kind: "circle" | "rect"; from: string; meta: { "data-id": string; class?: string | undefined; }; unit: "mm" | "cm"; note: string | null; };
    };
  };
  ticks: {
    subscribe: {
      path: "/api/ticks";
      query: { count?: number | undefined; failAt?: number | undefined; badAt?: number | undefined; pause?: number | undefined; };
      events: {
        tick: { n: number; };
        done: { total: number; };
      };
    };
  };
  trees: {
    create: {
      path: "/api/trees";
      body: RecursiveInput;
      response: { depth: number; root: Recursive; };
    };
  };
}

/** Pass to `createClient<Api>({ baseUrl, routes })`. */
export const routes = {
  "echo.retrieve": { method: "GET", path: "/api/echo/{+path}" },
  "notes.list": { method: "GET", path: "/api/notes", pagination: { style: "cursor", items: "items", limitParam: "limit", cursor: "cursor", cursorParam: "cursor" } },
  "notes.create": { method: "POST", path: "/api/notes", errors: [409] },
  "notes.retrieve": { method: "GET", path: "/api/notes/{id}", errors: [404] },
  "notes.update": { method: "PUT", path: "/api/notes/{id}" },
  "notes.delete": { method: "DELETE", path: "/api/notes/{id}", body: true, errors: [404] },
  "shapes.create": { method: "POST", path: "/api/shapes" },
  "ticks.subscribe": { method: "GET", path: "/api/ticks" },
  "trees.create": { method: "POST", path: "/api/trees" },
} as const;

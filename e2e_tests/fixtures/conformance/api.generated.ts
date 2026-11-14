// Auto-generated API types for use with createClient()
// Do not edit manually

// Named types
export type RecursiveInput = { name: string; next?: RecursiveInput | undefined; origin: RecursiveInput | null; };
export type RecursiveInput3 = string | number | boolean | null | RecursiveInput2[] | { [key: string]: RecursiveInput3; };
export type RecursiveInput2 = string | number | boolean | null | RecursiveInput2[] | { [key: string]: RecursiveInput3; };
export type RecursiveInput5 = { op: "add"; args: (number | RecursiveInput4 | RecursiveInput5)[]; };
export type RecursiveInput4 = { op: "neg"; of: number | RecursiveInput4 | RecursiveInput5; };
export type Recursive = { name: string; next?: Recursive | undefined; origin: Recursive | null; };
export type Recursive3 = string | number | boolean | null | Recursive2[] | { [key: string]: Recursive3; };
export type Recursive2 = string | number | boolean | null | Recursive2[] | { [key: string]: Recursive3; };
export type Recursive5 = { op: "add"; args: (number | Recursive4 | Recursive5)[]; };
export type Recursive4 = { op: "neg"; of: number | Recursive4 | Recursive5; };
export type RecursiveInput6 = { name: string; children: RecursiveInput6[]; };
export type Recursive6 = { name: string; children: Recursive6[]; };

export interface Api {
  echo: {
    retrieve: {
      path: "/api/echo/{+path}";
      params: { path: string; };
      response: { path: string; segments: string[]; };
    };
  };
  edges: {
    create: {
      path: "/api/edges";
      body: { short?: string | undefined; digits?: string | undefined; plain?: string | undefined; word?: string | undefined; count?: number | undefined; step?: number | undefined; flag?: boolean | undefined; maybe?: string | null | undefined; when?: string | undefined; id?: string | undefined; email?: string | undefined; };
      response: { received: string[]; maybe?: string | null | undefined; count?: number | undefined; };
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
  odd: {
    create: {
      path: "/api/odd";
      body: { type: string; createdAt: string; created_at: string; "2fa": boolean; pair: [string, number]; scores: Record<string, number>; loose: string | number | string[]; looseOrNull: string | number | null; version: 2; anything: unknown; chain: RecursiveInput; json: string | number | boolean | null | RecursiveInput2[] | Record<string, RecursiveInput3>; jsonIfAny?: string | number | boolean | null | RecursiveInput2[] | Record<string, RecursiveInput3> | undefined; expr: number | RecursiveInput4 | RecursiveInput5; limit?: number | null | undefined; };
      response: { type: string; createdAt: string; created_at: string; "2fa": boolean; pair: [string, number]; scores: Record<string, number>; loose: string | number | string[]; looseOrNull: string | number | null; version: 2; anything: unknown; chain: Recursive; json: string | number | boolean | null | Recursive2[] | Record<string, Recursive3>; jsonIfAny?: string | number | boolean | null | Recursive2[] | Record<string, Recursive3> | undefined; expr: number | Recursive4 | Recursive5; limit: number | null; };
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
      body: RecursiveInput6;
      response: { depth: number; root: Recursive6; };
    };
  };
}

/** Pass to `createClient<Api>({ baseUrl, routes })`. */
export const routes = {
  "echo.retrieve": { method: "GET", path: "/api/echo/{+path}" },
  "edges.create": { method: "POST", path: "/api/edges" },
  "notes.list": { method: "GET", path: "/api/notes", pagination: { style: "cursor", items: "items", limitParam: "limit", cursor: "cursor", cursorParam: "cursor" } },
  "notes.create": { method: "POST", path: "/api/notes", errors: [409] },
  "notes.retrieve": { method: "GET", path: "/api/notes/{id}", errors: [404] },
  "notes.update": { method: "PUT", path: "/api/notes/{id}" },
  "notes.delete": { method: "DELETE", path: "/api/notes/{id}", body: true, errors: [404] },
  "odd.create": { method: "POST", path: "/api/odd" },
  "shapes.create": { method: "POST", path: "/api/shapes" },
  "ticks.subscribe": { method: "GET", path: "/api/ticks" },
  "trees.create": { method: "POST", path: "/api/trees" },
} as const;

// Auto-generated API types for use with createClient()
// Do not edit manually

export interface Api {
  files: {
    retrieve: {
      path: "/api/files/{+path}";
      params: { path: string; };
      response: { path: string; };
    };
  };
  session: {
    update: {
      path: "/api/session";
      body: { theme: string; };
      response: { theme: string; };
    };
    delete: {
      path: "/api/session";
      response: { signedOut: boolean; };
    };
  };
  users: {
    events: {
      subscribe: {
        path: "/api/users/{id}/events";
        params: { id: string; };
        events: {
          seen: { userId: string; };
        };
      };
    };
    posts: {
      list: {
        path: "/api/users/{id}/posts";
        params: { id: string; };
        query: { limit?: number | undefined; };
        response: { id: string; userId: string; title: string; }[];
      };
      create: {
        path: "/api/users/{id}/posts";
        params: { id: string; };
        body: { title: string; };
        response: { id: string; userId: string; title: string; };
      };
      retrieve: {
        path: "/api/users/{id}/posts/{postId}";
        params: { id: string; postId: string; };
        response: { id: string; userId: string; title: string; };
      };
      replace: {
        path: "/api/users/{id}/posts/{postId}";
        params: { id: string; postId: string; };
        body: { title: string; };
        response: { via: string; post: { id: string; userId: string; title: string; }; };
      };
      delete: {
        path: "/api/users/{id}/posts/{postId}";
        params: { id: string; postId: string; };
        response: { deleted: string; };
      };
      update: {
        path: "/api/users/{id}/posts/{postId}";
        params: { id: string; postId: string; };
        body: { title?: string | undefined; };
        response: { via: string; post: { id: string; userId: string; title: string; }; };
      };
    };
  };
  health: {
    list: {
      path: "/health";
      response: { ok: boolean; };
    };
  };
}

/** Pass to `createClient<Api>({ baseUrl, routes })`. */
export const routes = {
  "files.retrieve": { method: "GET", path: "/api/files/{+path}" },
  "session.update": { method: "PUT", path: "/api/session" },
  "session.delete": { method: "DELETE", path: "/api/session" },
  "users.events.subscribe": { method: "GET", path: "/api/users/{id}/events" },
  "users.posts.list": { method: "GET", path: "/api/users/{id}/posts" },
  "users.posts.create": { method: "POST", path: "/api/users/{id}/posts" },
  "users.posts.retrieve": { method: "GET", path: "/api/users/{id}/posts/{postId}" },
  "users.posts.replace": { method: "PUT", path: "/api/users/{id}/posts/{postId}" },
  "users.posts.delete": { method: "DELETE", path: "/api/users/{id}/posts/{postId}" },
  "users.posts.update": { method: "PATCH", path: "/api/users/{id}/posts/{postId}" },
  "health.list": { method: "GET", path: "/health" },
} as const;

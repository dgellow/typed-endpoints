# typed-endpoints

Define API endpoints once with Zod schemas. Get runtime validation, OpenAPI
specs, and TypeScript types for free.

## Installation

```sh
# Deno
deno add jsr:@dgellow/typed-endpoints

# Bun
bunx jsr add @dgellow/typed-endpoints
```

The library runs on Deno and on Bun; both are tested in CI. The typed client,
the protocol module and the generators are the same everywhere. Route handlers
are provided for:

| Framework                            | Import                               | Route file                             | `--convention` |
| ------------------------------------ | ------------------------------------ | -------------------------------------- | -------------- |
| [Fresh](#fresh)                      | `@dgellow/typed-endpoints/fresh`     | `routes/api/users/[id].ts`             | `fresh`        |
| [Bun.serve](#bun)                    | `@dgellow/typed-endpoints/bun`       | `routes/api/users/[id].ts`             | `fresh`        |
| [Hono](#hono)                        | `@dgellow/typed-endpoints/hono`      | `routes/api/users/[id].ts`             | `fresh`        |
| [Next.js](#nextjs)                   | `@dgellow/typed-endpoints/next`      | `app/api/users/[id]/route.ts`          | `next`         |
| [SvelteKit](#sveltekit)              | `@dgellow/typed-endpoints/sveltekit` | `src/routes/api/users/[id]/+server.ts` | `sveltekit`    |
| [Astro](#astro)                      | `@dgellow/typed-endpoints/astro`     | `src/pages/api/users/[id].ts`          | `astro`        |
| [Nitro, h3](#nitro-and-h3)           | `@dgellow/typed-endpoints/nitro`     | `server/api/users/[id].get.ts`         | `nitro`        |
| [Plain fetch](#plain-fetch-handlers) | `@dgellow/typed-endpoints/fetch`     | `routes/api/users/[id].ts`             | `fresh`        |

Every integration has the same `endpoint()`, `sseEndpoint()` and
`createApiHandlers()`; what differs is the value a handler receives and how a
route file exports its handlers. The generators read each framework's own file
layout: pass the convention with `--convention` or the `convention` option.

## Usage

### Fresh

```typescript
// routes/api/users/[id].ts
import { createApiHandlers, endpoint } from "@dgellow/typed-endpoints/fresh";
import { z } from "zod";

// The `endpoint()` wrapper enables TypeScript to infer types from your Zod
// schemas and pass them to the handler callback. Without it, `params`, `body`,
// and `query` would be untyped. This is a TypeScript limitation - it can't
// infer types between sibling properties in an object literal.
export const handler = createApiHandlers({
  GET: endpoint({
    summary: "Get user by ID",
    params: z.object({ id: z.string() }),
    response: z.object({
      id: z.string(),
      email: z.string(),
    }),
    public: true, // include in OpenAPI spec
    async handler(ctx, { params }) {
      // params.id is typed as string
      const user = await getUser(params.id);
      if (!user) return Response.json({ error: "not found" }, { status: 404 });
      // A returned value is checked against `response`: at compile time by
      // its type, at runtime by parsing it. It is sent as JSON.
      return user;
    },
  }),

  PUT: endpoint({
    summary: "Update user",
    params: z.object({ id: z.string() }),
    body: z.object({
      email: z.email(),
      name: z.string().optional(),
    }),
    response: z.object({ success: z.boolean() }),
    async handler(ctx, { params, body }) {
      // body is validated and typed
      await updateUser(params.id, body);
      return { success: true };
    },
  }),
});
```

A handler returns either a value or a `Response`:

- A **value** has to be of the `response` schema's input type. It is parsed with
  the schema (defaults applied, unknown keys stripped), then sent as JSON with
  status 200. If the schema rejects it, the client gets a 500 and the issues are
  logged: the handler broke the endpoint's contract, which is a server bug.
- A **`Response`** is sent as it is and not checked. Use it for other status
  codes, headers, or bodies that are not JSON.

This holds for every integration below.

### Bun

The Bun integration has the same helpers as the Fresh one. A handler receives
Bun's request instead of a Fresh context:

```typescript
// routes/api/users/[id].ts
import { z } from "zod";
import { createApiHandlers, endpoint } from "@dgellow/typed-endpoints/bun";

export const handler = createApiHandlers({
  GET: endpoint({
    params: z.object({ id: z.string() }),
    response: z.object({ id: z.string(), name: z.string() }),
    handler: (_req, { params }) => Response.json(getUser(params.id)),
  }),
});
```

`createApiHandlers()` returns a route object (`{ GET, POST, ... }`) that
`Bun.serve()` takes as is. `fileRoutes()` builds the whole `routes` option from
a directory, with the file conventions the generators read:

```typescript
// server.ts
import { fileRoutes } from "@dgellow/typed-endpoints/bun";

Bun.serve({
  routes: await fileRoutes("routes"),
  // routes/api/users/[id].ts     -> /api/users/:id
  // routes/api/files/[...path].ts -> /api/files/*
});
```

Type and OpenAPI generation work on the same directory:

```typescript
import { generateOpenApiSpec, generateTypes } from "@dgellow/typed-endpoints";

await generateTypes({
  routesDirs: ["routes/api"],
  output: "src/api.ts",
  format: "client",
});
const spec = await generateOpenApiSpec({ routesDir: "routes/api" });
```

Differences from Deno:

- Route files are imported into the generating process. On Deno they are
  imported in a subprocess when a `deno.json` is given, so that they resolve
  through its import map; Bun resolves imports from the importing file, and the
  `config` option has no effect.
- A catch-all route is Bun's `*`, which has no parameter name. The handler reads
  the rest of the path from `req.url`.

### Hono

```typescript
import { Hono } from "hono";
import { z } from "zod";
import {
  createApiHandlers,
  endpoint,
  mountFileRoutes,
} from "@dgellow/typed-endpoints/hono";

const users = createApiHandlers({
  GET: endpoint({
    params: z.object({ id: z.string() }),
    handler: (c, { params }) => Response.json({ id: params.id }),
  }),
});

const app = new Hono();
app.get("/api/users/:id", users.GET);

// Or register a directory of route files that export `handler`:
await mountFileRoutes(app, "routes"); // routes/api/users/[id].ts -> /api/users/:id
```

`withContext<Context<Env>>()` returns the same helpers typed with your app's
context, so a handler sees its variables and bindings.

### Next.js

App Router route handlers. A `route.ts` exports one function per method;
destructure them from `createApiHandlers()`:

```typescript
// app/api/users/[id]/route.ts
import { z } from "zod";
import { createApiHandlers, endpoint } from "@dgellow/typed-endpoints/next";

export const { GET, DELETE } = createApiHandlers({
  GET: endpoint({
    params: z.object({ id: z.string() }),
    response: User,
    handler: (_request, { params }) => Response.json(getUser(params.id)),
  }),
  DELETE: endpoint({
    params: z.object({ id: z.string() }),
    handler: () => new Response(null, { status: 204 }),
  }),
});
```

`params` is awaited for you (Next.js passes a promise).
`withRequest<NextRequest>()` types the handler's request as `NextRequest`.

```sh
typed-endpoints -r app/api -o src/api.ts --format client --convention next
```

### SvelteKit

```typescript
// src/routes/api/users/[id]/+server.ts
import { z } from "zod";
import {
  createApiHandlers,
  endpoint,
} from "@dgellow/typed-endpoints/sveltekit";

export const { GET } = createApiHandlers({
  GET: endpoint({
    params: z.object({ id: z.string() }),
    handler: (_event, { params }) => Response.json(getUser(params.id)),
  }),
});
```

`withEvent<RequestEvent>()` types the handler's event, including `locals`.
Generate with `--convention sveltekit` on `src/routes`.

### Astro

```typescript
// src/pages/api/users/[id].ts
import { z } from "zod";
import { createApiHandlers, endpoint } from "@dgellow/typed-endpoints/astro";

export const prerender = false;

export const { GET } = createApiHandlers({
  GET: endpoint({
    params: z.object({ id: z.string() }),
    handler: (_context, { params }) => Response.json(getUser(params.id)),
  }),
});
```

`withContext<APIContext>()` types the handler's context. Generate with
`--convention astro` on `src/pages`.

### Nitro and h3

For h3 v2 and Nitro v3, where `event.req` is a standard `Request`. A Nitro route
file handles one method, named in the file name; `createHandler()` makes its
default export:

```typescript
// server/api/users/[id].get.ts
import { z } from "zod";
import { createHandler, endpoint } from "@dgellow/typed-endpoints/nitro";

export default createHandler(endpoint({
  params: z.object({ id: z.string() }),
  handler: (_event, { params }) => Response.json(getUser(params.id)),
}));
```

The generators take the method from the file name (`--convention nitro`); a file
without a method suffix answers every method and is left out of generated
output. For an h3 app, `createApiHandlers()` gives handlers by method:
`app.get("/users/:id", users.GET)`.

### Plain fetch handlers

For anything that serves `(request: Request) => Response`: `Deno.serve`,
Cloudflare Workers, `Bun.serve({ fetch })`. This integration brings a small
router:

```typescript
import { fileRouter } from "@dgellow/typed-endpoints/fetch";

// routes/api/users/[id].ts exports `handler`, as for Fresh and Bun
Deno.serve(await fileRouter("routes"));
```

`createRouter({ "/users/[id]": handlers, ... })` builds the same from a table. A
route with more static segments wins over one with parameters, which wins over a
catch-all; an unknown path is answered with 404, an undefined method with 405.

### Other frameworks

An integration is a few lines. `defineIntegration()` takes how to read the
request and the path parameters from what the framework passes to a handler, and
returns `endpoint()`, `sseEndpoint()` and `createApiHandlers()` typed for it:

```typescript
import { defineIntegration } from "@dgellow/typed-endpoints";

// A framework that calls handlers with (request, { params })
export const { endpoint, sseEndpoint, createApiHandlers } = defineIntegration<
  Request,
  [route: { params: Record<string, string> }]
>({
  request: (request) => request,
  params: (_request, route) => route.params,
});
```

How the integrations are verified:

- Fresh, Bun, Hono and h3 run in tests (`./scripts/test`, `./scripts/test-bun`).
- Next.js, SvelteKit and Astro are not run. Their handlers are type-checked
  against the frameworks' own type definitions, at pinned versions
  (`./scripts/check-framework-types`), and exercised with the arguments each
  framework documents.

### OpenAPI Generation

Add the Vite plugin to generate an OpenAPI spec at build time:

```typescript
// vite.config.ts
import { openApiPlugin } from "@dgellow/typed-endpoints";

export default defineConfig({
  plugins: [
    fresh(),
    openApiPlugin({
      info: { title: "My API", version: "1.0.0" },
      outputPath: "static/openapi.json",
    }),
  ],
});
```

By default only endpoints with `public: true` are included in the generated
spec.

### TypeScript Type Generation

Generate TypeScript types from your route schemas:

```bash
deno run -A jsr:@dgellow/typed-endpoints/cli -r routes/api -o src/api-types.ts
```

Or programmatically:

```typescript
import { generateTypes } from "@dgellow/typed-endpoints";

await generateTypes({
  routesDirs: ["routes/api"],
  output: "src/api-types.ts",
});
```

This generates types like:

```typescript
// GET /api/users
export type UsersGetQuery = { limit?: number | undefined };
export type UsersGetResponse = { id: string; name: string; email: string }[];

// POST /api/users
export type UsersPostRequest = { name: string; email: string };
export type UsersPostResponse = { id: string; name: string; email: string };
```

Request types (`Request`, `Query`, `Params`) describe what a caller sends: a
field with a default is optional. Response types describe what arrives over
JSON: a `z.date()` is a `string`, and schemas JSON cannot carry (`z.bigint()`,
`z.map()`, `z.set()`) fail generation with the path of the field. A recursive
schema becomes a named type; give it a name with `.meta({ id: "Name" })`.

Generation fails when two endpoints would produce the same type name, client
method or route id, and names both endpoints.

### Typed Client

Generate a resource-based API interface and use the typed client:

```bash
deno run -A jsr:@dgellow/typed-endpoints/cli -r routes/api -o src/api-types.ts --format client
```

This generates the types of the API and its routes as a value:

```typescript
export interface Api {
  users: {
    list: { path: "/api/users"; response: User[] };
    retrieve: {
      path: "/api/users/{id}";
      params: { id: string };
      response: User;
    };
    create: { path: "/api/users"; body: { name: string }; response: User };
    posts: {
      list: {
        path: "/api/users/{id}/posts";
        params: { id: string };
        response: Post[];
      };
    };
  };
}

export const routes = {
  "users.list": { method: "GET", path: "/api/users" },
  "users.retrieve": { method: "GET", path: "/api/users/{id}" },
  "users.create": { method: "POST", path: "/api/users" },
  "users.posts.list": { method: "GET", path: "/api/users/{id}/posts" },
} as const;
```

Use both with the typed client:

```typescript
import { createClient } from "@dgellow/typed-endpoints/client";
import { type Api, routes } from "./api-types.ts";

const client = createClient<Api>({ baseUrl: "http://localhost:3000", routes });

// All methods are typed
const users = await client.users.list();
const user = await client.users.retrieve("123");
const created = await client.users.create({ name: "Sam" });

// A parameter that is not the last segment goes in `params`; it is required
// and typed. The last one is the id argument.
const posts = await client.users.posts.list({ params: { id: "123" } });
const post = await client.users.posts.retrieve("42", { params: { id: "123" } });
```

How a route becomes a method:

| Route                            | Client call                                                                |
| -------------------------------- | -------------------------------------------------------------------------- |
| `GET /api/users`                 | `users.list(options?)`                                                     |
| `GET /api/users/[id]`            | `users.retrieve(id, options?)`                                             |
| `POST /api/users`                | `users.create(body, options?)`                                             |
| `PATCH /api/users/[id]`          | `users.update(id, body, options?)`                                         |
| `PUT /api/users/[id]`            | `users.update(...)`, or `users.replace(...)` when the path also has PATCH  |
| `DELETE /api/users/[id]`         | `users.delete(id, options?)`                                               |
| `DELETE /api/session`            | `session.delete(options?)`: no id, the path does not end with a parameter  |
| `DELETE /api/users/[id]/tags`    | `users.tags.delete(body, { params: { id } })` when the endpoint has a body |
| `GET /api/users/[id]/posts`      | `users.posts.list({ params: { id } })`                                     |
| `GET /api/files/[...path]`       | `files.retrieve("docs/a.md")`: a catch-all id keeps its slashes            |
| `GET /health`                    | `health.list()`: routes need not be under `/api`                           |
| SSE `GET /api/tasks/[id]/events` | `tasks.events.subscribe({ params: { id } })`                               |

Without `routes`, the client derives the URL from the property names
(`basePath/resource[/id]`, always PUT for `update`). That covers the first six
rows only; a call that passes `params` then throws.

#### Declared error responses

A call rejects with `ClientError` for any status outside 200 to 299; its `body`
is `unknown`. An endpoint can declare its error responses per status code:

```typescript
import { fail } from "@dgellow/typed-endpoints";

GET: endpoint({
  params: z.object({ id: z.string() }),
  response: Item,
  responses: { 404: NotFound, 409: Conflict },
  handler: (_ctx, { params }) =>
    items.get(params.id) ?? fail(404, { error: "not_found", id: params.id }),
}),
```

`fail(status, body)` answers with a declared error. The status has to be one the
endpoint declares and the body has to fit the schema declared for it; both are
compile errors otherwise. The body is parsed with that schema and sent as JSON
with that status. A body the schema rejects is a 500 and is logged, like a
returned value the response schema rejects.

Every client method then has `result()`. It takes the same arguments and
resolves with the response or a declared error, as a value typed by its status:

```typescript
const result = await client.items.update.result("a", { title, version });

if (result.ok) {
  result.data; // Item
} else if (result.status === 409) {
  result.error.current; // the body declared for 409
} else {
  result.error.id; // the body declared for 404
}
```

- What is declared is a value; what is unexpected is an exception. A status the
  endpoint does not declare (a 500, a 418) still rejects with `ClientError`,
  from `result()` as from a plain call
- A plain call is unchanged: it rejects for a declared status too
- `result()` works on every method. Without declared errors its type is the
  success alone: `{ ok: true; status: number; data }`
- The declared statuses are in the generated route table (`errors: [404, 409]`):
  types are erased, and the client has to know at run time which statuses to
  return. Without `routes`, nothing is known to be declared
- `--format types` names each body: `ItemsByIdPutError409`
- The client does not validate an error body, as it does not validate a
  response. On the server, `fail()` checks it; a hand-built `Response` is sent
  as it is
- A protocol step can have the same outcomes as its response: see "Steps that
  branch on an HTTP status"

### Pagination

Define paginated endpoints with automatic query/response schema generation:

```typescript
// routes/api/users.ts
import { createApiHandlers, endpoint } from "@dgellow/typed-endpoints/fresh";
import { cursor } from "@dgellow/typed-endpoints";
import { z } from "zod";

const UserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.email(),
});

// cursor.paginated generates both query and response schemas
const users = cursor.paginated({
  item: UserSchema,
  names: { items: "data", cursor: "nextCursor" },
  defaultLimit: 20,
  maxLimit: 100,
});

export const handler = createApiHandlers({
  GET: endpoint({
    ...users,
    public: true,
    async handler(ctx, { query }) {
      // query.cursor is string | undefined
      // query.limit is number (with default 20, max 100)
      const { rows, next } = await getUsers(query.cursor, query.limit);
      // page() puts the items and the cursor under the configured names.
      return users.page({ items: rows, cursor: next });
    },
  }),
});
```

`page()` builds the response of a page: the items and what the style keeps track
of, under the field names the helper was configured with (nested ones included).
Its argument is typed by the helper:

| Style                | `page({ ... })`                                              |
| -------------------- | ------------------------------------------------------------ |
| `cursor`             | `items`, `cursor?` (absent on the last page)                 |
| `cursorId`           | `items`                                                      |
| `offset`             | `items`, `total`                                             |
| `page`               | `items`, and `total` / `totalPages` if the helper names them |
| `url`                | `items`, `next?`, and `prev?` if the helper names it         |
| with `extraResponse` | `extra: { ... }`, required                                   |

On the client, a `list` method of a paginated endpoint can be iterated, page by
page or item by item:

```typescript
import { createClient } from "@dgellow/typed-endpoints/client";
import { type Api, routes } from "./api-types.ts";

const client = createClient<Api>({ baseUrl, routes });

for await (const user of client.users.list.items({ query: { limit: 50 } })) {
  user.email; // string
}

for await (const page of client.users.list.pages()) {
  page.data; // User[]
  page.nextCursor; // string | undefined
}

const first = await client.users.list(); // still one page
```

The client asks for the next page the way the endpoint's style says, until the
server says there is none:

| Style      | Next request                       | Stops when                                                 |
| ---------- | ---------------------------------- | ---------------------------------------------------------- |
| `cursor`   | the cursor of the last response    | the response has no cursor                                 |
| `cursorId` | the id of the last item            | a page is empty, or shorter than the limit asked for       |
| `offset`   | the offset plus the items received | the offset reaches the total, or a page is empty           |
| `page`     | the next page number               | the page count or the total is reached, or a page is short |
| `url`      | the URL the response names         | the response names none                                    |

- Pages are requested as they are consumed: leaving the loop stops the requests
- The options of the call (`query`, `params`, `signal`) go with every page;
  iteration starts at the page they ask for
- Items are typed as a single page's are, a `projection()` included:
  `list.items({ query: { fields: ["name"] } })` yields `{ name: string }`
- A server that answers with the cursor or URL it was just asked for is an
  error, not a loop. A next URL is followed on the origin of `baseUrl` only: the
  request carries the client's headers
- The client needs the generated route table (`routes`): the pagination metadata
  is in it, since types are erased

Available pagination styles:

- `cursor.paginated()` - Cursor-based pagination (opaque cursor string)
- `cursorId.paginated()` - Last-item-ID cursor (like "after" parameter)
- `offset.paginated()` - Offset/limit pagination with total count
- `page.paginated()` - Page number pagination
- `url.paginated()` - URL-based pagination (like GitHub API)

Each style generates appropriate query params and response fields. Supports:

- Custom field names (e.g., `items: "data"`, `cursor: "nextCursor"`)
- Dot-notation for nested response structure, in every style:
  `items: "data.items"`, `total: "meta.total"`, `nextUrl: "links.next"`. Fields
  that share a parent are merged under it, and so are `extraResponse` fields
- Extra query/response fields via `extraQuery` and `extraResponse`
- Page-size and position parameters are integers; a fraction is a 400

Pagination metadata is included in:

- Generated TypeScript types (`pagination: { style: "cursor"; ... }`) and the
  generated route table, which is where the client reads it
- OpenAPI spec (`x-pagination` extension)

### Responses That Depend on the Request

`GET /users?fields=id,name` returns objects with two properties.
`GET /users/1?expand=team` returns a user with its team. The type of such a
response is a function of the request, which a fixed response type cannot say:
it is either too wide (every property optional) or wrong.

`projection()` and `expansion()` declare the dependency in the route:

```typescript
import { createApiHandlers, endpoint } from "@dgellow/typed-endpoints/fresh";
import {
  expansion,
  fieldsOf,
  projection,
  relationsOf,
} from "@dgellow/typed-endpoints";

const User = z.object({ id: z.string(), name: z.string(), email: z.string() });
const Team = z.object({ id: z.string(), title: z.string() });

// routes/api/users.ts
export const handler = createApiHandlers({
  GET: endpoint({
    query: z.object({ fields: fieldsOf(User) }), // optional list of property names
    response: z.object({ data: z.array(projection(User, "fields")) }),
    // Return complete objects; the response schema cuts them down.
    handler: async () => ({ data: await getUsers() }),
  }),
});

// routes/api/users/[id].ts
const relations = { team: Team, manager: User };
export const handler = createApiHandlers({
  GET: endpoint({
    params: z.object({ id: z.string() }),
    query: z.object({ expand: relationsOf(relations) }),
    response: expansion(User, "expand", relations),
    handler: (_ctx, { params, query }) => { ... },
  }),
});
```

The client types generated with `--format client` compute the response type of
each call from its arguments:

```typescript
const page = await client.users.list({ query: { fields: ["id", "name"] } });
page.data[0].name; // string
page.data[0].email; // compile error: not requested

const all = await client.users.list();
all.data[0].email; // string

const user = await client.users.retrieve("1", { query: { expand: ["team"] } });
user.team.title; // string, not optional
user.manager; // compile error: not expanded

client.users.list({ query: { fields: ["password"] } }); // compile error
```

What the type says is what the list is known to contain:

| Argument                                   | Response type                                   |
| ------------------------------------------ | ----------------------------------------------- |
| `fields: ["id", "name"]`                   | `{ id: string; name: string }`                  |
| parameter absent, or `fields: []`          | the complete object                             |
| `fields: someArray` (`("id" \| "name")[]`) | `{ id?: string; name?: string }`                |
| `fields: ["id", nameOrEmail]`              | `{ id: string; name?: string; email?: string }` |

A list written in the call is a tuple, so its members are certain. A list
computed elsewhere is an array that may hold any subset, so the properties it
may name are optional.

How it works:

- The builders return ordinary Zod schemas: `projection(User, "fields")` is
  `User.partial()`, `expansion(User, "expand", relations)` is `User` with the
  relations optional. Request validation, OpenAPI output and `--format types`
  use them as they are.
- The schema also carries the rule. The generator writes it into the client
  types as `Dependent<Projection<User, "fields">, Partial<User>>`.
- A client method of such an endpoint is generic in its options
  (`<const O>(options: O) => Promise<Resolve<Response, O>>`). `Resolve` applies
  the rule to the type of the options.
- TypeScript has no type-level functions. `Projection` and `Expansion` are
  interfaces whose `response` member refers to `this["request"]`; intersecting
  the interface with `{ request: O }` applies it.

On the server, a handler that returns a value (not a `Response`) gets the rule
applied to it: the listed properties are picked, relations that were not asked
for are dropped. What the client's type says is then what the server sent. A
handler that builds its own `Response` is trusted; `select()` implements a
projection by hand. The client does not check what it receives.

#### Selections written as one string

Many APIs take the selection as one string, with nesting:
`GET /posts?select=id,author(name),comments(text,by(name))`. `selection()`
declares it, and the client parses the string of each call at the type level:

```typescript
import { selection, selectOf } from "@dgellow/typed-endpoints";

const Author = z.object({ id: z.string(), name: z.string() });
const Post = z.object({
  id: z.string(),
  title: z.string(),
  author: Author,
  reviewer: Author.nullable(),
  comments: z.array(z.object({ text: z.string(), by: Author })),
});

// routes/api/posts.ts
export const handler = createApiHandlers({
  GET: endpoint({
    query: z.object({ select: selectOf(Post) }),
    response: z.array(selection(Post, "select")),
    // Complete objects; the response schema cuts them down.
    handler: async () => await getPosts(),
  }),
});
```

```typescript
const posts = await client.posts.list({
  query: { select: "id,author(name),comments(text,by(name))" },
});
// { id: string; author: { name: string };
//   comments: { text: string; by: { name: string } }[] }[]

posts[0].comments[0].by.name; // string
posts[0].title; // compile error: not selected

client.posts.list({ query: { select: "id,author(age)" } });
// TS2322: Type '"id,author(age)"' is not assignable to type
//   '"id,author(age)" & SelectError<"\"author.age\" is not a field">'.
```

| Select string                 | Response type                                       |
| ----------------------------- | --------------------------------------------------- |
| `"id,author(name)"`           | `{ id: string; author: { name: string } }`          |
| `"reviewer(name)"`            | `{ reviewer: { name: string } \| null }`            |
| `"*,author(name)"`            | every property, `author` cut down to `name`         |
| parameter absent              | the complete object                                 |
| a `string` that is no literal | every property optional, at every depth             |
| `"id,nope"`, `"title(x)"`     | compile error: not a field; has no fields to select |
| `"id,author(name"`, `"id,,"`  | compile error: missing `)`; expected a field name   |

Grammar: `select = item ("," item)*`, `item = name | name "(" select ")"`, `*`
for every property of a level; spaces around items are ignored. Optional and
nullable properties stay optional and nullable; a selection inside an array
applies to each element.

How it works:

- The parser is a recursive descent written in template literal types
  (`ParseSelect`), the way postgrest-js types its `select()` argument: each
  production returns what it parsed and the rest of the string. `Selected`
  applies the tree to the object type
- The same grammar is parsed at run time by `parseSelect()`. The tests hold the
  two together: one literal has to be a value of the type the type-level parser
  gives and equal to what the runtime parser returns, for trees, for error
  messages, and for the problems found against a schema
- A family can ask something of the request (`requires`). `Selection` asks for a
  parameter of type `SelectError<reason>` when the string does not fit, which no
  string is. That is what turns an unknown field into a compile error at the
  call, with the reason in it
- `selectOf(Post)` is the query schema: it refuses, with the same reasons, a
  string the types would refuse. A client that does not use the types gets a 400

### Server-Sent Events (SSE)

Define typed SSE endpoints with `sseEndpoint`:

```typescript
// routes/api/tasks/[id].ts
import { createApiHandlers, sseEndpoint } from "@dgellow/typed-endpoints/fresh";
import { z } from "zod";

export const handler = createApiHandlers({
  GET: sseEndpoint({
    params: z.object({ id: z.string() }),
    events: {
      progress: z.object({ percent: z.number() }),
      complete: z.object({ result: z.string() }),
      error: z.object({ message: z.string() }),
    },
    async *handler(ctx, { params }, signal) {
      for (let i = 0; i <= 100; i += 10) {
        if (signal.aborted) return;
        yield { event: "progress", data: { percent: i } };
        await new Promise((r) => setTimeout(r, 100));
      }
      yield { event: "complete", data: { result: "done" } };
    },
  }),
});
```

Subscribe from the client with typed events:

```typescript
for await (const event of client.tasks.subscribe("task-123")) {
  switch (event.event) {
    case "progress":
      console.log(`${event.data.percent}%`); // percent is number
      break;
    case "complete":
      console.log(event.data.result); // result is string
      break;
  }
}
```

What the server does with what the handler yields:

- Each event is parsed with the schema of its name before it is sent: defaults
  are applied and unknown keys stripped, as for a value a REST handler returns
- A handler that throws, or yields an event its schema rejects or the endpoint
  does not declare, fails the stream: the events sent so far stay sent, the bad
  one is not sent, and the stream ends with the comment line `: error` before it
  closes. The cause is logged. A stream has no status code once it has begun;
  the comment is how a failure is told apart from the end of the events. Other
  event-stream clients ignore comments
- A handler that returns ends the stream normally
- `keepAlive: 15000` sends a comment line after that many milliseconds without
  an event, for intermediaries with an idle timeout. Clients ignore comments
- The handler receives `lastEventId`, the `Last-Event-ID` header of a client
  that reconnects, and `signal`, which aborts when the client is gone

```typescript
async *handler(_ctx, { params, lastEventId }, signal) {
  // Resume after the event the client already has.
  for await (const entry of log.after(params.id, lastEventId, { signal })) {
    yield { event: "progress", data: entry, id: entry.id };
  }
}
```

What the client does:

- A stream the server closes ends the iteration
- A stream the server ended as a failure (`SseStreamError`), a dropped
  connection and a 5xx response are retried: the client reconnects with the id
  of the last event it received. `maxReconnectAttempts` (default 5) connections
  in a row that bring no event reject the iteration with the last error; the
  count starts over when an event arrives
- A 4xx response and an event whose data is not JSON reject the iteration at
  once

### Resource Laws

A route with GET and PUT on one path is a lens: GET is a view of state the
server keeps, PUT updates that state from a value. A lens is expected to obey
laws, and each is a statement about HTTP that clients rely on.
`checkResourceLaws()` checks them against a server, with bodies generated from
the PUT body schema (`arbitrary()`):

| Law       | Requests                            | Holds when              | A handler that fails it                                       |
| --------- | ----------------------------------- | ----------------------- | ------------------------------------------------------------- |
| `get-get` | GET, GET                            | the two views are equal | a view that changes by being read (a read counter)            |
| `get-put` | GET, PUT of that view, GET          | the view did not change | a PUT that resets what the body does not carry (a like count) |
| `put-get` | PUT `v`, GET                        | the view contains `v`   | a PUT that accepts a field and does not store it              |
| `put-put` | PUT `w`, GET, PUT `u`, PUT `w`, GET | the two views are equal | a PUT that merges like PATCH, or that appends or counts       |

`put-put` is the lens law in full (the last PUT wins and nothing of an earlier
one remains); idempotence is the case `u = w`.

```typescript
import {
  checkResourceLaws,
  formatResourceLawsReport,
} from "@dgellow/typed-endpoints";
import { handler } from "./routes/api/notes/[id].ts";

const report = await checkResourceLaws(handler, {
  url: "http://localhost:8000/api/notes/1",
  ignore: ["updatedAt"],
});
if (!report.ok) throw new Error(formatResourceLawsReport(report));
```

The report of a PUT that stores the title and nothing else of its body:

```
resource laws: PUT http://localhost:8000/api/notes/1, 20 runs, seed 0
  get-get: held in 20 of 20 runs
  get-put: held in 20 of 20 runs
  put-get: held in 0 of 20 runs, violated in 20
    run 0: PUT {"title":"afd","tags":["pqlp"]}, GET
      tags.0: put "pqlp", read "a"
  put-put: held in 20 of 20 runs
```

- The first argument is what `createApiHandlers()` returns, or the method
  definitions (`{ GET: {}, PUT: { body } }`). A route without GET, or without a
  body schema on PUT, is a compile error that states which
- The view is usually larger than the body (an id, timestamps): `put-get` asks
  that the view contains the body as the schema parses it (defaults filled in,
  transforms applied), field by field. The other laws compare whole views
- `ignore` names places the laws do not compare, as dotted paths with `*` for
  any key or index: `updatedAt`, `meta.revision`, `items.*.etag`
- `send` replaces `fetch`. A fetch handler checks the laws without a server:
  `send: createRouter({ "/api/notes/[id]": handler })`
- `method: "PATCH"` checks a resource that is updated with PATCH. A partial
  update obeys `put-get` and `get-put` and not `put-put` (a field of `u` that
  `w` does not mention remains), so `put-put` is left out unless `laws` asks for
  it
- `runs` (default 20), `seed` (default 0), `laws`, `headers`, and `value` for
  bodies with constraints the schema does not state
- `report.laws[law]` has `held`, `violations` (the requests of the run and the
  places that differ), `refusals` (a request answered outside 200-299) and
  `skips` (`get-put` when the view is not a value the body schema accepts).
  `report.ok` is true when every checked law held in every run

Limits:

- The check writes to the resource it is pointed at, and the resource has to
  exist: a 404 on the first GET is a refusal
- It is a test, not a proof. `put-put` shows a merging PUT only in runs where
  the generated bodies differ in the optional fields they carry: 2 of 20 runs in
  the test fixture, whose body has one optional field
- State is observed through GET. What GET does not show is not compared
- `get-put` sees a PUT that resets a value once, on the state the check found;
  after the check's own first PUT the value is already reset
- A resource whose PUT carries a precondition (a version for optimistic
  concurrency) refuses generated bodies; those runs are refusals

End to end against a live server, with a handler broken on purpose:
`e2e_tests/resource_laws_test.ts`.

### Other Languages: Python and FastAPI

The routes can leave TypeScript. `generateFastApi()` writes one Python module
from a routes directory:

```bash
typed-endpoints -r routes/api -o server/api_generated.py --format fastapi
```

The module holds:

- a Pydantic model for every request part, response and declared error body
- `Handlers`, a protocol with one method per operation, typed by those models
- `create_router(handlers)`, a FastAPI `APIRouter` that validates each request,
  calls the handler and checks what it returns
- `create_app(handlers)`, an application with that router and with validation
  failures answered as the TypeScript handlers answer them

The application implements `Handlers` in a file of its own. Generating again
never overwrites it, and a type checker reports a handler that no longer fits
the routes:

```python
from typing import Literal

from fastapi.responses import Response

import api_generated as api


class Notes:
    async def notes_retrieve(
        self, params: api.NotesRetrieveParams
    ) -> api.NotesRetrieveResponse | api.Fail[Literal[404], api.NotFound] | Response:
        note = store.get(params.id)
        if note is None:
            return api.Fail(404, api.NotFound(error="not_found", id=params.id))
        return note

    ...


app = api.create_app(Notes())
```

A handler returns the response value, a `Fail` with a status the operation
declares, or a `Response`, which is sent as it is: the same three as in
TypeScript. The handler of a server-sent event stream is an async generator of
typed events:

```python
async def ticks_list(
    self, query: api.TicksListQuery, last_event_id: str | None
) -> AsyncIterator[api.TicksListEvent]:
    start = 0 if last_event_id is None else int(last_event_id) + 1
    for n in range(start, query.count):
        yield api.TicksListTickEvent(data=api.TicksListTickData(n=n), id=str(n))
```

The stream is framed as the TypeScript handlers frame it, byte for byte. A
handler that raises, or yields an event its model rejects, ends the stream with
the comment `: error`, which the TypeScript client reads as a failure and
reconnects after; the endpoint's `keepAlive` interval is kept. A status the
operation does not declare is an error for the type checker; past the type
checker it is a 500 and is logged, as is a value the response model rejects.

What is kept the same on both sides:

|                                                     | TypeScript handlers                                    | Generated FastAPI module                                                                                                                                                         |
| --------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A body's types                                      | not coerced (`"5"` is not a number)                    | strict models for bodies and responses                                                                                                                                           |
| Query and path parameters                           | coerced from text where the schema says so             | coerced                                                                                                                                                                          |
| Lengths, bounds, patterns, literals, closed objects | Zod                                                    | the same constraints on the Pydantic field                                                                                                                                       |
| An optional field that was not set                  | absent from the response                               | absent (`exclude_unset`), never `null`                                                                                                                                           |
| What a handler returns or yields                    | parsed by the schema before it is sent                 | validated again as plain data, also when it is a model instance: Pydantic trusts an instance, and one built with `model_construct()` or changed afterwards may not fit its model |
| A request that fails validation                     | 400 `{ error, in, issues: [{ path, message, code }] }` | the same shape, same `in` and `path`                                                                                                                                             |
| A field name Python cannot use (`from`, `data-id`)  | as written                                             | a Python attribute (`from_`) with the wire name as alias                                                                                                                         |
| The same object in two operations                   | one type                                               | one class, with a name per operation                                                                                                                                             |

The description FastAPI serves of the application (`/openapi.json`, `/docs`)
says what the application answers: for each operation the response model, the
declared errors and the 400 of a failed validation, and not the 422 that FastAPI
would send by itself.

What differs, and what does not cross:

- The message and the code of a validation issue are Pydantic's
  (`string_too_short`), not Zod's (`too_small`)
- A `transform()` in a schema is TypeScript code. Python sees the input of a
  request schema; the result of a transform in a response is `Any`
- A string with a format (`date-time`, `uuid`) stays a `str` with Zod's pattern.
  Parsing it and writing it back could change the text
- A JSON body sent as `text/plain` is read by the TypeScript handlers and
  refused by FastAPI; a form body is a 400 there, not a 415
- `\d` in a pattern matches every Unicode digit; `2.0` is refused for an
  integer; an explicit `null` is accepted for an optional field; a scalar query
  parameter given twice takes the last value; a value that fits no member of a
  union is reported once per member. The conformance suite asserts each of
  these, so the list stays true
- A type that refers to itself and is not an object (a JSON value) is a `type`
  statement, which needs Python 3.12
- Not generated yet: request-dependent responses (`projection()`,
  `selection()`), protocols, and event streams in the Python client (listed in a
  comment in its module)

**A Python client.** `generatePythonClient()` (`--format python-client`) writes
a module with the same models and two classes, `Client` and `AsyncClient`
(httpx). For every operation:

```python
import api_client as api

client = api.Client("http://localhost:8000")

note = client.notes_retrieve("n1")  # raises ApiError outside 200-299

result = client.notes_retrieve_result("n1")  # a declared error is a value
if isinstance(result, api.Fail):
    result.status  # Literal[404]
    result.body  # NotFound

for item in client.notes_list_items(api.NotesListQuery(tag=["urgent"])):
    ...  # every item, page after page
```

| TypeScript client                          | Python client                                                                                                                                       |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notes.retrieve(id)`                       | `notes_retrieve(id)`: the parsed response; `ApiError` for a status outside 200-299                                                                  |
| `notes.retrieve.result(id)`                | `notes_retrieve_result(id)`: the response, or `Fail[Literal[404], NotFound]`; a status the operation does not declare still raises                  |
| `notes.list.pages()`, `notes.list.items()` | `notes_list_pages()`, `notes_list_items()`: iterators (async iterators on `AsyncClient`) that find the next page by the endpoint's pagination style |

Methods are named after the operation id; there is no resource hierarchy. A body
field that was not set is not sent, and responses are parsed by strict models.
The client's tests run against the fixture's TypeScript handlers and against the
generated FastAPI application.

The module is built from a contract, which is also available on its own:
`generateContract()` (`--format contract`) describes every operation with its
method, path template, declared error statuses, pagination metadata and a JSON
Schema (draft 2020-12) for each part. Request parts are the input side of the
Zod schema, responses the output side.

How it is checked (`./scripts/test-python`, through `uv`): the generated modules
and a hand-written implementation of `Handlers` pass pyright in strict mode; the
application runs under uvicorn; and the tests that hold for the fixture's
TypeScript server hold for it, using the TypeScript client generated from the
same routes: CRUD, declared errors as values, cursor pagination, validation
failures, a DELETE body, a catch-all path, a recursive schema, event streams
(frames, failure and resume, keep-alive), and the lens laws of
`checkResourceLaws()`.

### Other Languages: Rust and axum

`generateAxum()` writes one Rust module from a routes directory:

```bash
typed-endpoints -r routes/api -o server/src/api_generated.rs --format axum
```

The module needs `axum` 0.8, `serde` (with `derive`), `serde_json`, `tracing`
and `fancy-regex` (patterns with lookarounds). It is written as Rust is written:
it passes `cargo fmt --check` under the 2021 and 2024 style editions and
`cargo clippy -- -D warnings -W clippy::pedantic`. It holds, in this order:

- a serde type for every request part, response and declared error body
- `InternalError`, and an error type per operation that declares errors: one
  variant per status, named as the status is (`NotFound`), and `Internal`
- `Handlers`, a trait with one method per operation. A method that is missing or
  no longer fits the routes does not compile
- `router(handlers)`, an `axum::Router` that checks each request, calls the
  handler and checks what it returns
- two private modules: the contract as static data, and the runtime that checks
  values against it

```rust
use my_crate::api_generated as api;

struct Notes { /* ... */ }

impl api::Handlers for Notes {
    async fn notes_retrieve(
        &self,
        params: api::NotesRetrieveParams,
    ) -> Result<api::NotesRetrieveResponse, api::NotesRetrieveError> {
        let row = self.db.find(&params.id).await?; // any error: a 500
        row.ok_or_else(|| api::NotFound { id: params.id }.into()) // the declared 404
    }

    // ...
}

let app = api::router(Notes::new());
```

Every method returns a `Result`. A declared error is a variant of the
operation's error type, and its body converts into it. Anything else is an
`InternalError`, which every error and every message converts into, so `?` works
on whatever a handler calls; it is answered as a 500 that says nothing about the
cause and reported through `tracing`.

Rust was added to see where the design gives way under a language with nominal
types, value types and no `null`. What it took:

| TypeScript says                                         | Rust needs                                                   | What the generator does                                                                                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| a union or a set of literals, written in place          | a name for every type                                        | names them after the place they are in (`ShapesCreateBodyUnit`); the same values in a second place are the same type under another name |
| `{ a: string }` twice is one type                       | two structs are two types                                    | recognises the same object, whatever document it is in, and writes `pub type B = A`                                                     |
| what goes in and what comes out are one schema          | a type for each side would make a handler copy between them  | one type for both sides: a default is filled in when a request leaves it out, and the runtime refuses unknown members                   |
| a union told apart by a member                          | an enum, and a way to tell its variants apart                | `#[serde(tag = "kind")]`; the variants are structs without that member                                                                  |
| a member that is always one string                      | no literal types                                             | serde writes it (`#[serde(tag = "error", rename = "not_found")]`); the struct has no field for it                                       |
| a type that contains itself                             | indirection, or the type has no size                         | `Box` where a cycle closes, none behind a `Vec` or a map                                                                                |
| `type Json = string \| null \| Json[] \| ...`           | a recursive type has to be nominal                           | an enum of its own name, with a `Null` variant                                                                                          |
| `x?: T \| null`: absent, null and a value               | `Option` has two states                                      | `MaybeAbsent<T>`: `Absent`, `Null`, `Value(T)`                                                                                          |
| one `number`                                            | `i64`, `u64` and `f64`                                       | `u64` for an integer that is not negative; `2.0` is accepted for an integer, as in JavaScript, and reaches the handler as `2`           |
| a pattern is a JavaScript `RegExp`                      | another regex dialect: `\d` matches every Unicode digit      | rewrites `\d`, `\w`, `\b` to what they mean in JavaScript; each pattern is compiled once, when the router is built                      |
| every issue of a request, with its path                 | `serde` stops at the first, and knows no lengths or patterns | does not validate with `serde`: checks the JSON against the contract first, then builds the typed value                                 |
| `fail(404, body)`, the status checked against a literal | no literal types                                             | an enum per operation: `NotesRetrieveError::NotFound(NotFound)`                                                                         |
| a handler may throw                                     | a function that can fail says so in its type                 | every method returns a `Result`; `InternalError` takes any error                                                                        |

The contract is in the module as data the compiler checks (`static` values of a
`Schema` type), not as text parsed when the server starts, and the runtime
interprets it and words its issues as Zod does. That turned out closer to the
TypeScript handlers than mapping the schema onto the validation library of the
language, which is what the Python generator does. The conformance suite sends
27 requests that have to be refused (`e2e_tests/conformance/refusals.json`
records what the TypeScript handlers answer). Compared as JSON values:

|                                                 | axum | FastAPI |
| ----------------------------------------------- | ---- | ------- |
| Same status, same issues, same words            | 27   | 1       |
| Same status, same issue paths in the same order | 27   | 19      |
| Same status                                     | 27   | 26      |
| Differences the suite declares                  | 0    | 8       |

As text the axum answers differ from the TypeScript ones in 25 of the 27: the
members of an object are written in alphabetical order.

What does not cross, or not yet:

- A handler gets the path parameters, the query and the body, and nothing else
  of the request: no header, no cookie, nothing a layer put into the request's
  extensions
- A success is always a 200 or, without a response schema, a 204. There are no
  response headers and no response written by hand
- A constant that is not a string (`z.literal(2)`) is an `i64` in the type; the
  check against the contract still refuses 3
- The contract does not say whether a query member is coerced
  (`z.coerce.number()`) or not (`z.number()`, which no query text satisfies in
  TypeScript): every number and boolean of a query or a path is read from text
- A request that axum's own extractors refuse (a path that is not UTF-8, a body
  over the size limit) is answered in plain text, not in the shape of a 400
- A 500 is reported through `tracing`: an application without a subscriber
  writes nothing
- Not generated yet: event streams (listed in a comment in the module), a
  client, request-dependent responses, protocols

How it is checked (`./scripts/test-rust`): the generated module and a
hand-written implementation of `Handlers` are formatted as rustfmt formats and
have nothing for clippy to report, its pedantic lints included; the server runs;
and the conformance tests of the Python section, minus the event streams, hold
for it with no declared difference. Among them: three bodies nested 40 levels
deep are checked in milliseconds, a handler that fails outside the contract is a
500 that does not say why, and `2.0` is accepted where the contract says `2`.
One behaviour has no permanent test, because the fixture cannot hold it: a
pattern that does not compile stops the server when the router is built.

## API

### `createApiHandlers(def)`

Creates Fresh route handlers with automatic request validation.

Each method definition can include:

- `body` - Zod schema for the JSON request body, for every method except GET and
  HEAD (a DELETE that declares a body is validated like a POST)
- `query` - Zod schema for query parameters
- `params` - Zod schema for path parameters
- `response` - Zod schema for the response: types and parses what the handler
  returns
- `responses` - Additional response schemas by status code
- `handler` - The request handler function
- `public` - Include in OpenAPI spec (default: false)
- `summary` - OpenAPI summary
- `description` - OpenAPI description
- `tags` - OpenAPI tags

A request that fails validation does not reach the handler. The answer is a 400
whose body names the part that failed and each issue, as Zod reports it:

```json
{
  "error": "Validation error: name: Invalid input: expected string, received number",
  "in": "body",
  "issues": [
    {
      "path": ["name"],
      "message": "Invalid input: expected string, received number",
      "code": "invalid_type"
    }
  ]
}
```

- `in` is `body`, `query`, `params`, or `json` for a body that is not valid JSON
- A request without a body is validated as `undefined`: a body schema that is
  `.optional()` accepts it, any other says what is missing
- A body that is not JSON under a content type that is not JSON (a form post) is
  a 415 with `in: "content-type"`. JSON under `text/plain`, which `fetch()`
  sends for a string body when no header is set, is read
- The OpenAPI spec declares this 400 (component `InvalidRequest`) for every
  operation that has a `body`, `query` or `params` schema and does not declare a
  400 of its own

Limits: there is no schema for request headers or cookies (a handler reads them
from the request), and a body is JSON or nothing (no form or multipart bodies).

### `sseEndpoint(def)`

Defines a Server-Sent Events endpoint with typed events.

Definition includes:

- `events` - Object mapping event names to Zod schemas (required)
- `query` - Zod schema for query parameters
- `params` - Zod schema for path parameters
- `handler` - AsyncGenerator that yields typed events
- `public`, `summary`, `description`, `tags` - OpenAPI metadata

### `createClient<Api>(config)`

Creates a typed HTTP client from a generated Api interface.

Config can be a URL string or an object:

- `baseUrl` - Base URL for requests
- `routes` - The route table generated next to `Api`. Each call takes its HTTP
  method and URL from it
- `basePath` - API path prefix when no `routes` are given (default: "/api")
- `headers` - Default headers for all requests
- `fetch` - Custom fetch implementation

Methods:

- `list(options?)` - GET collection
- `retrieve(id, options?)` - GET single resource
- `create(body, options?)` - POST new resource
- `update(id, body, options?)` - PATCH resource, or PUT when the route has no
  PATCH
- `replace(id, body, options?)` - PUT resource, when the route has both
- `delete(id, options?)` - DELETE resource; `delete(id, body, options?)` when
  the endpoint declares a body (needs the generated route table)
- `subscribe(id?, options?)` - SSE subscription (returns AsyncIterable)

The `id` argument exists when the route's path ends with a parameter. Options:
`query`, `params` (path parameters other than the id), `signal`.

### Pagination Helpers

All pagination helpers return `{ query, response, __pagination }` to spread into
`endpoint()`.

#### `cursor.paginated(config)`

Cursor-based pagination with opaque cursor string.

Config:

- `item` - Zod schema for each item (required)
- `names` - Custom field names: `items`, `cursor`, `cursorParam`, `limitParam`
- `extraQuery` - Additional query parameters
- `extraResponse` - Additional response fields
- `defaultLimit` - Default limit (default: 20)
- `maxLimit` - Maximum limit (default: 100)

#### `cursorId.paginated(config)`

Last-item-ID pagination (like `after` parameter).

Config: Same as cursor, plus `names.idField` for which item field to use as ID.

#### `offset.paginated(config)`

Offset/limit pagination with total count.

Config: Same as cursor, plus `names.total` and `names.offsetParam`.

#### `page.paginated(config)`

Page number pagination.

Config: Same as cursor, plus `names.total`, `names.totalPages`,
`names.pageParam`, `names.perPageParam`, `defaultPerPage`, `maxPerPage`.

#### `url.paginated(config)`

URL-based pagination (like GitHub API). Response includes next/prev URLs.

Config:

- `item` - Zod schema for each item (required)
- `names` - Custom field names: `items`, `nextUrl`, `prevUrl`
- `extraResponse` - Additional response fields

### `openApiPlugin(options)`

Vite plugin that generates OpenAPI 3.1 spec at build time.

Options:

- `routesDir` - Directory to scan (default: "routes/api")
- `outputPath` - Output file path (default: "static/openapi.json")
- `info` - OpenAPI info object (title, version, description)
- `servers` - OpenAPI servers array
- `strict` - Throw when a route file cannot be imported or two operations share
  an `operationId` (default: false, which logs and continues)
- `failOnError` - Fail the build when generation fails; implies `strict`
  (default: false, which logs the error and lets the build finish)

Every operation gets an `operationId`: the endpoint's own, or one derived from
method and path (`GET /api/users/[id]` → `usersRetrieve`). `--format routes`
uses the same ids as keys.

### `protocolTypesPlugin(options)`

Vite plugin that generates branded protocol types at build time.

Options:

- `protocolModule` - Path to the protocol module file (required)
- `outputPath` - Output file path (default: "src/protocol-types.ts")
- `config` - Path to deno.json (for import map resolution)
- `failOnError` - Fail the build when generation fails (default: false)

### `generateTypes(options)`

Generates TypeScript types from route Zod schemas.

Options:

- `routesDirs` - Directories to scan (default: ["routes/api"])
- `output` - Output file path (if provided, writes to file)
- `config` - Path to deno.json (needed when routes use import map aliases)
- `format` - Output format: "types", "client", or "routes" (default: "types")

Returns the generated types as a string.

### Protocol Type Generation

Generate branded TypeScript types from a protocol module:

```bash
deno run -A jsr:@dgellow/typed-endpoints/cli --format protocol --protocol ./my-protocol.ts -o src/protocol-types.ts
```

Or use the Vite plugin for build-time generation:

```typescript
// vite.config.ts
import { protocolTypesPlugin } from "@dgellow/typed-endpoints";

export default defineConfig({
  plugins: [
    fresh(),
    protocolTypesPlugin({
      protocolModule: "./src/my-protocol.ts",
      outputPath: "src/protocol-types.ts",
    }),
  ],
});
```

### CLI

```
typed-endpoints - Generate TypeScript types from API route Zod schemas

Options:
  -r, --routes <dir>    Routes directory, repeatable (default: routes/api)
  -o, --output <file>   Output file path (required)
  -f, --format <fmt>    Output format: types, client, routes, protocol, contract,
                        fastapi, python-client or axum (default: types)
  --convention <name>   Route file layout: fresh, next, sveltekit, astro, or nitro
                        (default: fresh; also the layout for Bun, Hono and fetch)
  -p, --protocol <file> Protocol module path (required when --format protocol)
  --client-import <mod> Module the client format imports its helper types from
                        (default: @dgellow/typed-endpoints/client)
  -c, --config <file>   Path to deno.json (auto-detected if not provided)
  -h, --help            Show help

Formats:
  types    - Flat type exports (UsersGetResponse, etc.)
  client   - Resource-based Api interface for createClient()
  routes   - Runtime route metadata for createHttpExecutor()
  protocol - Branded types from a protocol module
  contract - The routes as JSON: each operation with a JSON Schema per part
  fastapi  - A Python module: Pydantic models, a Handlers protocol and a
             FastAPI router
  python-client - A Python module: Pydantic models and an httpx client
  axum     - A Rust module: serde types, a Handlers trait and an axum router
```

## Architecture

```
src/
├── core/
│   ├── types.ts       # Shared types (including SSE)
│   ├── validation.ts  # Request validation
│   ├── routes.ts      # Route discovery, path conversion, operationId derivation
│   ├── handlers.ts    # Route handlers with validation, for any framework
│   ├── file_routes.ts # Loading a directory of route files into a routing table
│   ├── module_api.ts  # How a route module exposes its method definitions
│   ├── runtime.ts     # What differs between Deno and Bun (module resolution)
│   ├── zod_internals.ts # Readers for Zod schema internals
│   ├── arbitrary.ts   # arbitrary(schema): a seeded, valid value of any schema
│   ├── laws.ts        # checkResourceLaws(): lens laws of GET/PUT, against a server
│   ├── dependent.ts   # projection(), expansion(): responses typed by the request
│   ├── dependent_types.ts # Type-level functions: ResponseFamily, Apply, Resolve
│   └── openapi.ts     # OpenAPI spec generation (x-pagination)
├── contract/          # The routes as language-neutral data (JSON Schema per part)
│   └── types.ts       # TypeGraph: names, shared types and cycles, for generators
├── python/            # Pydantic models, a FastAPI router and an httpx client
├── rust/              # serde types, a schema-checking runtime and an axum router
├── pagination/
│   ├── types.ts       # Pagination type definitions
│   └── index.ts       # cursor, cursorId, offset, page, url helpers
├── protocol/          # Protocol schemas (experimental)
│   ├── types.ts       # Step, DependentStep, MappedStep, Sequence, Protocol types
│   ├── dsl.ts         # Builder functions: step(), dependentStep(), mappedStep(), etc.
│   ├── mapping.ts     # Declarative field mappings: fromStep(), deriveSchemaWithLiterals()
│   ├── client.ts      # Type-safe protocol session client
│   ├── plan.ts        # PlanOf, ResultOf, runPlan(): running compositions
│   ├── fuzz.ts        # fuzzProtocol(): the calls a protocol forbids, sent to a server
│   ├── errors.ts      # Errors thrown by protocol sessions
│   ├── introspect.ts  # Schema path lookup used by validateProtocol()
│   ├── http.ts        # HTTP executor for real endpoint connections
│   ├── openapi.ts     # x-protocols OpenAPI extension
│   ├── compose.ts     # Endpoint composition (fromEndpoint, fromEndpointMapped)
│   ├── typegen.ts     # Branded type generation from protocols
│   ├── oauth.ts       # OAuth 2.0 reference implementation
│   └── index.ts       # Module exports
├── client/
│   ├── index.ts       # Typed HTTP client
│   ├── sse.ts         # text/event-stream parser
│   └── types.ts       # Client type definitions
├── tsgen/             # TypeScript type generation
│   ├── zod.ts         # Zod schema to TypeScript type text
│   ├── extract.ts     # Route import and schema rendering
│   └── generate.ts    # types, client and routes output formats
├── integrations/
│   ├── fresh.ts       # Fresh v2 runtime adapter (endpoint, sseEndpoint)
│   ├── bun.ts         # Bun.serve() adapter (endpoint, sseEndpoint, fileRoutes)
│   ├── hono.ts        # Hono adapter (mountFileRoutes)
│   ├── next.ts        # Next.js App Router route handlers
│   ├── sveltekit.ts   # SvelteKit +server.ts endpoints
│   ├── astro.ts       # Astro endpoints
│   ├── nitro.ts       # Nitro v3 / h3 v2 event handlers
│   ├── fetch.ts       # Plain fetch handlers and a router
│   └── vite.ts        # Vite build-time plugins (OpenAPI, protocol types)
├── cli.ts             # CLI for type generation
└── mod.ts             # Root exports
```

## Protocol Schemas (Experimental)

Multi-step protocols like OAuth flows, file sessions, and database transactions
require more than single request/response validation. The `protocol` module
provides a DSL for defining **protocol shapes** - sequences of operations where
each step's request type can depend on the previous step's response.

This is a direct implementation of insights from
[André Videla's](https://andrevidela.com/) research on container morphisms.

### The Key Innovation: Sequential Product (>>)

From André Videla's
[Container Morphisms for Composable Interactive Systems](https://arxiv.org/abs/2407.16713)
(APLAS 2024), the Sequential Product operator captures the essence of multi-step
protocols:

```idris
-- From aplas-code/src/APLAS.idr line 248
(>>) : Container -> Container -> Container
(>>) c1 c2 = (x : Σ c1.req (\r => c1.res r -> c2.req))
            !> Σ (c1.res x.π1) (\r => c2.res (x.π2 r))
```

Translation: **The request type of step 2 is a function of the response of
step 1.**

This is the missing primitive that enables type-safe OAuth, multi-step wizards,
database transactions, and any protocol where later steps depend on earlier
responses.

### Type System Limitations

True sequential product (`>>`) requires Σ (dependent pair):

```
A × B           -- normal pair: value of type A and value of type B
Σ (a : A). B(a) -- dependent pair: value 'a' of type A and value of type B(a)
                -- where B(a) is a type that changes depending on the VALUE of 'a'
```

TypeScript doesn't have dependent types, so our implementation is a pragmatic
approximation:

**What we track at compile time:**

- Which step _names_ have been completed (via union type `TDone`)
- What is known about each response (via `TSeen`): which _variant_ of a union
  came back, whether an optional field has a value
- Which steps are available next (via `AvailableSteps<TSteps, TDone, TSeen>`): a
  step needs its `dependsOn` step and every step its `requestMapping` reads
  from, and their responses have to be known to be of the kind the step can
  follow. `exchange` after `authorize` does not compile until the session knows
  that `authorize` succeeded
- The shape of each request, including for dependent and mapped steps
- That the `prev` a dependent step expects is a response its dependency can
  produce

**What we enforce at runtime:**

- The actual dependent typing (e.g., `code` in exchange must equal `code` from
  authorize)
- The same variant conditions, for callers that bypass the types
- Schema validation via Zod

The `request: (prev) => Schema` function is what André Videla calls a
"continuation" - it receives the runtime value from the previous step and
constructs a schema with `z.literal(prev.code)`. This gives us the dependent
behavior, but the type system only knows "exchange is available after authorize"

- not "exchange's code field must match authorize's response value."

For comparison, the coproduct (`+`) _is_ fully expressible at the type level
because TypeScript unions are structural:

```typescript
type AuthResponse =
  | { type: "success"; code: string }
  | { type: "error"; error: string };
```

This asymmetry is inherent to TypeScript's type system - we get the practical
benefits of dependent protocols through runtime validation, with compile-time
enforcement of step ordering.

### Example: OAuth 2.0 Authorization Code Flow

```typescript
import {
  dependentStep,
  protocol,
  step,
} from "@dgellow/typed-endpoints/protocol";
import { z } from "zod";

const AuthorizeResponse = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("success"),
    code: z.string(),
    state: z.string(),
  }),
  z.object({ type: z.literal("error"), error: z.string() }),
]);

const ExchangeResponse = z.object({
  access_token: z.string(),
  token_type: z.literal("Bearer"),
  expires_in: z.number(),
  refresh_token: z.string().optional(),
});

// Step 1: Authorization Request (independent step)
const authorizeStep = step({
  name: "authorize",
  request: z.object({
    response_type: z.literal("code"),
    client_id: z.string(),
    redirect_uri: z.url().optional(),
    scope: z.string().optional(),
    state: z.string(),
  }),
  response: AuthorizeResponse,
});

// Step 2: Token Exchange - REQUEST DEPENDS ON STEP 1 RESPONSE
const exchangeStep = dependentStep({
  name: "exchange",
  // The step object: `prev` is typed from its response schema.
  dependsOn: authorizeStep,
  // Which responses this step can follow. TypeScript infers the type guard
  // from the predicate, so `prev` below is the success variant.
  when: (prev) => prev.type === "success",
  request: (prev) =>
    z.object({
      grant_type: z.literal("authorization_code"),
      code: z.literal(prev.code), // THE KEY: enforces exact code from step 1
      client_id: z.string(),
      client_secret: z.string(),
    }),
  response: ExchangeResponse,
});

// Step 3: Token Refresh - depends on exchange response. The reference
// implementation wraps it in renewing(): see "Renewal" below.
const refreshStep = dependentStep({
  name: "refresh",
  dependsOn: exchangeStep,
  // A guard that TypeScript cannot infer is written out.
  when: (prev): prev is typeof prev & { refresh_token: string } =>
    prev.refresh_token !== undefined,
  request: (prev) =>
    z.object({
      grant_type: z.literal("refresh_token"),
      refresh_token: z.literal(prev.refresh_token), // From exchange response
      client_id: z.string(),
    }),
  response: z.object({ access_token: z.string(), expires_in: z.number() }),
});

// Complete protocol definition
const oauth2Protocol = protocol({
  name: "OAuth2AuthorizationCode",
  description: "OAuth 2.0 Authorization Code Grant (RFC 6749 Section 4.1)",
  initial: "authorize",
  steps: {
    authorize: authorizeStep,
    exchange: exchangeStep,
    refresh: refreshStep,
  },
});
```

The reference implementation in `src/protocol/oauth.ts` also has a `revoke`
step, declared as `terminal`.

`dependsOn` also accepts the name of the step (`dependsOn: "authorize"`). The
type of `prev` is then an annotation:
`request: (prev: { code: string }) => ...`. `protocol()` compares it with the
response of the named step and rejects an annotation that no response of that
step satisfies.

### Core Primitives

The DSL maps category theory concepts from André's research to TypeScript:

| Primitive         | Category Theory         | Description                                   |
| ----------------- | ----------------------- | --------------------------------------------- |
| `step()`          | Container               | Independent request/response pair             |
| `dependentStep()` | Sequential Product (>>) | Request schema derived from previous response |
| `mappedStep()`    | Sequential Product (>>) | Declarative field mappings (static analysis)  |
| `fromStep()`      | Field reference         | Maps a field to a previous step's response    |
| `sequence()`      | Sequential composition  | Chain of steps executed in order              |
| `repeat()`        | Kleene Star (*)         | Zero-or-more repetitions                      |
| `repeat1()`       | Kleene Plus (+)         | One-or-more repetitions                       |
| `choice()`        | Coproduct (+)           | One of several alternatives                   |
| `branch()`        | Conditional             | Branch on the response of an earlier step     |
| `parallel()`      | Tensor (⊗)              | Concurrent execution                          |

`sequence()`, `repeat()`, `repeat1()`, `choice()`, `branch()` and `parallel()`
build nodes that nest. A session does not interpret them: it executes steps by
their dependencies. `runPlan()` does.

### Running a Composition

A composition has a request type and a response type of its own, computed from
its nodes (`PlanOf`, `ResultOf`). The definitions are the ones of André Videla's
containers:

| Node              | Request (`PlanOf`)                                         | Response (`ResultOf`)        |
| ----------------- | ---------------------------------------------------------- | ---------------------------- |
| step              | the step's request                                         | the step's response          |
| `sequence(a, b)`  | `{ first: PlanOf<a>, rest: (result) => PlanOf<b> }`        | `[ResultOf<a>, ResultOf<b>]` |
| `repeat(a)`       | `undefined`, or `{ next: PlanOf<a>, rest: (result) => … }` | `ResultOf<a>[]`              |
| `choice(a, b)`    | `{ choose, plan }` for one option                          | `{ choice, result }`         |
| `branch(s, p, …)` | `{ ifTrue: (prev) => plan, ifFalse: (prev) => plan }`      | `{ holds, result }`          |
| `parallel(a, b)`  | `[PlanOf<a>, PlanOf<b>]`                                   | `[ResultOf<a>, ResultOf<b>]` |

`rest` of a sequence receives the result of the first node and returns the plan
of the remaining ones. `rest` of a repetition receives the result of one run and
returns the plan of the remaining runs, or `undefined` to stop.

A later request that uses an earlier response is a closure: the continuation
receives the response, typed, and returns the next plan.

```typescript
import {
  choice,
  each,
  repeat,
  runPlan,
  sequence,
} from "@dgellow/typed-endpoints/protocol";

// OPEN (READ | WRITE)* CLOSE
const fileSession = sequence(open, repeat(choice(read, write)), close);

const [opened, operations, closed] = await runPlan(fileSession, {
  first: { path: "notes.txt" },
  rest: ({ handle }) => ({
    // One write per line. `each()` builds the plan of a repetition from a list.
    first: each(lines, (data) => ({
      choose: "write",
      plan: { handle, data },
    })),
    rest: () => ({ handle }),
  }),
}, executor);
// operations: ({ choice: "read"; result: { data: string } }
//            | { choice: "write"; result: { written: number } })[]
```

A repetition whose length depends on the responses returns `undefined` from
`rest` when it is done:

```typescript
const poll = (id: string): PlanOf<typeof polling> => ({
  next: { id },
  rest: (job) => job.status === "running" ? poll(id) : undefined,
});
```

The predicate of a `branch` is asked about the latest response of the step it
names. When the predicate is a type guard, each side of the plan receives its
half of the type:

```typescript
const login = sequence(
  authorize,
  branch(authorize, (prev) => prev.type === "success", {
    then: exchange,
    else: report,
  }),
);

await runPlan(login, {
  first: { client_id: "app" },
  rest: () => ({
    ifTrue: (prev) => ({ code: prev.code }), // prev: the success variant
    ifFalse: (prev) => ({ reason: prev.error }), // prev: the error variant
  }),
}, executor);
```

The empty sequence, `sequence()`, is the node that does nothing: its plan is
`undefined` and its result `[]`. It is the other side of a branch that has
nothing to do.

#### What a plan knows

`PlanOf` computes, for every point of a composition, which steps have certainly
run there and what their latest response is known to be (`Known`, `After`). A
step that cannot run with that knowledge has the plan type `NotReady`, which no
value has, so the composition cannot be run:

| Composition                                                                      | Why it has no plan                                                                               |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `sequence(exchange, authorize)`                                                  | `exchange` runs before the step it depends on                                                    |
| `sequence(authorize, exchange)`                                                  | `exchange` follows a success only (`when`); `authorize` may have failed. It needs a `branch`     |
| `branch(authorize, isSuccess, { then: report, else: exchange })`                 | wrong side: there the response is the error variant                                              |
| `sequence(exchange, exchange)` after a success                                   | `exchange` revokes `authorize`; the second run has nothing to follow                             |
| `repeat(exchange)` after a success                                               | same, from the second run on                                                                     |
| `parallel(authorize, exchange)`                                                  | the arms do not see each other                                                                   |
| `sequence(exchange, refresh)`, `refresh` forwarding the optional `refresh_token` | the field is not known to have a value; it needs `branch(exchange, present("refresh_token"), …)` |

How knowledge flows:

- after a step: its response is known, what it revokes is forgotten
- after a `repeat`: what holds whether it ran or not
- after a `choice` or a `branch`: what every option agrees on
- after a `parallel`: what any arm established, less what any arm revokes
- on the sides of a `branch`: the response of the step it names, narrowed

The uninhabited type says what is missing:
`NotReady<"exchange", { authorize:
Success }, { authorize: Success | Failure }>`
reads "this step cannot run here; it needs `authorize` to be `Success`; known
here: `Success | Failure`".

A helper that returns part of a plan names what is known where it is used:
`PlanOf<typeof pages, { login: LoggedIn }>`. `e2e_tests/plan_http_test.ts` runs
such a plan over HTTP: a login, a branch on its outcome, then every page of a
cursor-paginated endpoint as a repetition.

What the runner guarantees:

- Every request is parsed with its step's schema before the executor sees it,
  every response after. A continuation never receives a response its schema
  rejects.
- A dependent or mapped step reads the latest response of its dependency,
  wherever in the plan that step ran. `when`, forwarded values and `revoking()`
  apply as in a session, with the same errors.
- Each continuation is called once, with the response it belongs to. A plan
  holds no session value that could be used twice or after it went stale.
- The arms of a `parallel` node start from what was known before the node and do
  not see each other's responses. The node settles when every arm has: no step
  is in flight when it rejects.
- `repeat` bounds (`min`, `max`) are checked, the upper one before the request
  that would exceed it is sent. A plan that never returns `undefined` is stopped
  after `maxRepetitions` runs (default 10000).
- A plan whose shape does not fit the node (possible only through `any`) is
  rejected with `PlanError`, whose `at` is the position in the node tree
  (`sequence[1][0]`).

The conditions `PlanOf` checks are checked again when the plan runs, for a plan
that got past the types: `StepNotAvailableError` for a dependency that has not
run, `StepRefusedError` for a response the step cannot follow.

No plan has a member called `then`. A continuation may be async, and JavaScript
treats a value with a `then` method as a promise.

### Protocol Introspection

```typescript
import {
  buildDependencyGraph,
  getStepNames,
  topologicalSort,
  validateProtocol,
} from "@dgellow/typed-endpoints/protocol";

// Validate protocol is well-formed
const result = validateProtocol(oauth2Protocol);
// { valid: true, errors: [] }

// Build dependency graph
const graph = buildDependencyGraph(oauth2Protocol);
// Map { "authorize" => [], "exchange" => ["authorize"], "refresh" => ["exchange"] }

// Topological sort for execution order
const order = topologicalSort(oauth2Protocol);
// ["authorize", "exchange", "refresh"]
```

What a malformed protocol is caught by:

| Condition                                                    | `protocol()` (compile time) | `validateProtocol()` |
| ------------------------------------------------------------ | --------------------------- | -------------------- |
| A step's `name` equals its key                               | yes                         | yes                  |
| A dependency, revoked step or renewed step exists            | yes                         | yes                  |
| `initial` has no dependencies; no dependency cycle           | no                          | yes                  |
| A mapping key is a field of the request schema               | yes, in `mappedStep()`      | yes                  |
| A mapping's source step exists and its path is in a response | yes                         | yes                  |
| A mapped value is assignable to the field it is forwarded to | yes                         | primitive kinds      |
| The annotated `prev` of a dependent step fits the dependency | yes                         | no                   |
| Only steps: no `sequence()`, `repeat()`, ... in the step map | yes                         | yes                  |

`createSession()` refuses a protocol that fails `validateProtocol()`. Where a
type does not say (a response typed `unknown`, a record, a path typed `string`)
a mapping is accepted.

### What's Implemented

- Core type definitions (`Step`, `DependentStep`, `MappedStep`, `Sequence`,
  `Repeat`, `Choice`, etc.)
- DSL builder functions (`step()`, `dependentStep()`, `mappedStep()`,
  `sequence()`, `repeat()`, etc.)
- **Declarative field mappings** via `mappedStep()` and `fromStep()` — static,
  inspectable alternative to `dependentStep()` for literal field forwarding
- Protocol validation and introspection utilities
- OAuth 2.0 Authorization Code Flow as reference implementation
- **Type-safe protocol client** with compile-time step enforcement
- **HTTP executor** for connecting protocols to real endpoints
- **Endpoint composition** via `fromEndpoint()`, `fromEndpointDependent()`, and
  `fromEndpointMapped()`
- **Branded type generation** via `generateProtocolTypes()` — compile-time
  provenance enforcement from `mappedStep()` definitions
- **OpenAPI `x-protocols` extension**: protocols in the spec, each step linked
  to its operation
- **Plans** (`runPlan()`): compositions as request types, with compile-time
  tracking of what has run
- **Protocol fuzzing** (`fuzzProtocol()`): checks that a server refuses the
  calls the protocol forbids

### Type-Safe Protocol Client

The protocol client enforces valid step sequences at compile time. After
executing a step, TypeScript knows which steps become available:

```typescript
import {
  createMockExecutor,
  createSession,
  present,
} from "@dgellow/typed-endpoints/protocol";

// Create a session for the protocol
const executor = createMockExecutor(oauth2Protocol, {
  authorize: { type: "success", code: "auth-code-123", state: "random" },
  exchange: {
    access_token: "token-xyz",
    token_type: "Bearer",
    expires_in: 3600,
  },
});

const session = createSession(oauth2Protocol, executor);

// Execute steps - TypeScript tracks which are available
const { response: auth, session: s1 } = await session.execute("authorize", {
  response_type: "code",
  client_id: "my-client",
  state: "random",
});

// "exchange" follows a successful authorize only. Here the session knows
// that authorize ran, not which variant came back:
//   s1.execute("exchange", ...)   // compile error
//
// ready() runs the conditions of the step against the responses the session
// holds. The result is the session typed with what they prove, or undefined.
const granted = s1.ready("exchange");
if (!granted) {
  console.log(auth.type); // "error"
  return;
}

// The request is typed: a missing or misspelled field does not compile.
const { response: tokens, session: s2 } = await granted.execute("exchange", {
  grant_type: "authorization_code",
  // Typed as string: the session knows authorize returned the success variant.
  // Checked at runtime: must equal the code authorize returned.
  code: granted.responses.authorize.code,
  client_id: "my-client",
  client_secret: "secret",
});

// narrow() establishes a fact with a guard of your own; present() is a guard
// for "this field has a value".
const refreshable = s2.narrow("exchange", present("refresh_token"));
```

#### Revocation and single use

A session's state can also shrink. `revoking()` declares that a step ends what
earlier steps established:

```typescript
// Logging out ends the login.
const logout = revoking(
  dependentStep({ name: "logout", dependsOn: login, ... }),
  ["login", "profile"],
);

// An authorization code can be exchanged once (RFC 6749, section 4.1.2):
// the step revokes its own dependency.
const exchange = revoking(
  dependentStep({ name: "exchange", dependsOn: authorize, ... }),
  ["authorize"],
);

const { session: s2 } = await granted.execute("exchange", request);
s2.execute("exchange", request); // compile error: authorize is spent
s2.responses.authorize; // compile error: the response left the session
```

After the step, the revoked steps count as not executed: they leave the session
type and the stored responses, and steps that depend on them are unavailable
until they run again.

The types follow the session value `execute()` returns. The value it was called
on still exists with its earlier type, and TypeScript cannot retire it. A
single-use session closes that gap at runtime:

```typescript
const session = createSession(oauth2Protocol, executor, { singleUse: true });

const { session: s2 } = await granted.execute("exchange", request);
await granted.execute("exchange", request); // throws SessionSpentError
```

Each session value then executes one step; a failed `execute()` does not spend
it.

#### Sessions that end early

A client can leave a protocol half-way: a lock is acquired and the work throws,
a file is opened and the function returns early. The types cannot forbid that in
TypeScript (a value may always be dropped), so the protocol says what happens
instead. It names the step that releases what a session holds, and a session
that is ended before a terminal step runs it:

```typescript
const locking = protocol({
  name: "Locking",
  initial: "acquire",
  terminal: ["release"],
  onAbandon: "release",
  steps: { acquire, renew, release },
});

{
  await using session = createSession(locking, executor);
  const acquired = await session.execute("acquire", { resource: "db" });
  await work(); // throws, or the block returns early
} // "release" has run, with the token "acquire" returned
```

- The session fills in the request, so `onAbandon` accepts only a step it can
  run by itself: a mapped step whose required fields are all forwarded
  (`fromStep()`), or a step without required fields. Another step is a compile
  error on `onAbandon`, and an error of `validateProtocol()`
- Every value `execute()` returns belongs to the session `createSession()`
  started. Ending any of them (`await using`, `session.abandon()`) ends the
  session, on the state its most recent step reached
- Nothing runs when no step was executed, when the last step is a terminal one,
  or when the `onAbandon` step cannot run in the state reached (its dependency
  did not run)
- A session ends once. Afterwards `execute()` on any of its values throws
  `SessionEndedError`
- `createSession(protocol, executor, { linear: true })`: the session has to
  reach a terminal step. Ending it earlier still runs the `onAbandon` step and
  then throws `SessionAbandonedError` (`history`, `released`). If the block was
  left by an exception, both are reported in a `SuppressedError`
- `abandon()` returns the step that ran with its request and response, or
  `undefined`

Limits:

- A fork (two steps executed on the same session value) is followed along the
  value that ran last; what the other branch holds is not released. `singleUse`
  refuses forks
- An `onAbandon` step that fails is not retried; its error is the error of the
  block
- `runPlan()` has no session: a plan that fails half-way releases nothing

Against a live server (a lock service; the block is left by a return and by an
exception): `e2e_tests/protocol_abandon_test.ts`. The distinction is the one
between affine and linear session types: an affine session may be dropped, with
a defined effect (Lagaillardie, Neykova, Yoshida, ECOOP 2022).

#### Renewal

A dependent step reads the latest response of the one step it depends on. Some
values move on: a refresh returns new tokens, a page returns the next cursor.
`renewing()` declares that the response of a step takes the place of an earlier
step's response:

```typescript
// Every response of `nextPage` is the latest page.
const nextPage = renewing(
  dependentStep({
    name: "nextPage",
    dependsOn: firstPage,
    when: present("cursor"),
    request: (page) => z.object({ cursor: z.literal(page.cursor) }),
    response: PageSchema,
  }),
  firstPage,
);

// Only a successful refresh renews the tokens, and a response without a
// refresh token keeps the one there was (RFC 6749, section 6).
const refresh = renewing(
  dependentStep({ name: "refresh", dependsOn: exchange, ... }),
  exchange,
  (response, previous) =>
    response.type === "success"
      ? {
        ...response,
        refresh_token: response.refresh_token ?? previous?.refresh_token,
      }
      : undefined,
);
```

After a renewing step, every step that depends on the renewed one reads the new
response:

- the second `refresh` has to send the refresh token the first one returned;
  sending the token of the `exchange` again is an `InvalidRequestError` before
  the request leaves the client
- `revoke` names the current access token, not the one of the `exchange`
- the request for page three is built from the cursor of page two

The second form takes a function of the step's response and the response it
would replace. Its result is the replacement; `undefined` renews nothing. The
replacement is parsed with the renewed step's response schema.

What the session knew about the renewed response (`narrow()`, `ready()`) is
replaced by the type of the replacement: after a `refresh`, the session knows
the exchange succeeded but not that it has a refresh token, so a further
`refresh` needs `ready("refresh")` again, and `revoke` does not. In a plan the
same knowledge flows through `After`.

A session's type changes with every step, which makes a loop over session values
awkward to type. A plan loops with `repeat`:

```typescript
// firstPage >> (has a cursor ? nextPage : nothing)*
const browse = sequence(
  firstPage,
  repeat(
    branch(firstPage, present("cursor"), { then: nextPage, else: sequence() }),
  ),
);
```

Key features:

- **Compile-time step enforcement**: Can only execute steps whose dependencies
  have run
- **Variant-dependent availability**: A step that follows one variant of a
  response (`when`), or forwards a field only some responses have, is available
  once `ready()` or `narrow()` has established it. `canExecute()` and
  `availableSteps()` apply the same conditions at runtime
- **Typed requests**: The request of every step kind is checked against its
  schema type
- **Literal type preservation**: `dependsOn: "authorize"` is preserved as the
  literal `"authorize"`, not widened to `string`
- **Accumulating state**: Session responses are typed as they accumulate
- **Runtime validation**: Request/response schemas are validated at runtime
- **Typed errors**: `execute()` rejects with a subclass of `ProtocolError` that
  says what went wrong, with the step name and, for validation failures, the Zod
  issues:

  | Error                   | Meaning                                                               |
  | ----------------------- | --------------------------------------------------------------------- |
  | `StepNotAvailableError` | A step it depends on has not run (`requires`)                         |
  | `StepRefusedError`      | Its dependencies ran, but their responses do not allow it (`because`) |
  | `InvalidRequestError`   | The request does not match the step's schema (`issues`)               |
  | `InvalidResponseError`  | The response does not match the step's schema (`issues`)              |
  | `UnknownStepError`      | The protocol has no such step                                         |
  | `SessionSpentError`     | Single-use session: this value already executed a step (`spentBy`)    |
  | `SessionEndedError`     | The session was ended (`await using`, `abandon()`)                    |
  | `SessionAbandonedError` | Linear session: ended before a terminal step (`history`, `released`)  |

### HTTP Executor

Connect protocol sessions to real HTTP endpoints using generated route metadata:

```bash
# Generate route metadata from your API
deno run -A jsr:@dgellow/typed-endpoints/cli -r routes/api -o src/api-routes.ts --format routes
```

This generates:

```typescript
export const apiRoutes = {
  authLogin: { method: "POST", path: "/api/auth/login" },
  authExchange: { method: "POST", path: "/api/auth/exchange" },
} as const;
```

A key is the endpoint's `operationId` (`authLogin` and `authExchange` above are
set on the endpoints). An endpoint without one gets a derived id:
`POST /api/auth/login` → `authLoginCreate`.

Use with the HTTP executor:

```typescript
import {
  createHttpExecutor,
  createSession,
} from "@dgellow/typed-endpoints/protocol";
import { apiRoutes } from "./api-routes.ts";

// Define steps with operationId matching route keys
const loginStep = step({
  name: "login",
  operationId: "authLogin", // Maps to apiRoutes.authLogin
  request: z.object({ username: z.string(), password: z.string() }),
  response: z.object({ accessToken: z.string() }),
});

// Create HTTP executor
const executor = createHttpExecutor(authProtocol, {
  baseUrl: "https://api.example.com",
  routes: apiRoutes,
  auth: {
    fromStep: "login",
    tokenPath: "accessToken", // Auto-inject token from login response
  },
});

const session = createSession(authProtocol, executor);
const { response } = await session.execute("login", {
  username: "alice",
  password: "secret",
});
// Makes POST https://api.example.com/api/auth/login
```

Features:

- **Route mapping**: a step made with `fromEndpoint()` and a `path` carries its
  route; other steps map to HTTP endpoints via `operationId` and `routes`. Every
  step is resolved when the executor is created
- **Auth propagation**: Automatically inject tokens from previous step responses
- **Request mapping**: `{userId}` in the path is filled from the request; for a
  step created from an endpoint each remaining field goes to the query string or
  the JSON body according to the endpoint's `query` and `body` schemas; for a
  hand-written step the remaining fields go to the body, or to the query string
  for GET and HEAD
- **Error handling**: `HttpError` class with status, statusText, and body; a
  step made with `outcome: true` gets its declared error statuses as responses

### Endpoint Composition

Instead of duplicating schemas between endpoints and protocol steps, compose
protocols directly from your endpoint definitions:

```typescript
import { handler as loginHandler } from "./routes/api/auth/login.ts";
import { handler as refreshHandler } from "./routes/api/auth/refresh.ts";
import { handler as profileHandler } from "./routes/api/auth/profile.ts";
import {
  createHttpExecutor,
  fromEndpoint,
  fromEndpointDependent,
  fromEndpointMapped,
  fromStep,
  protocol,
} from "@dgellow/typed-endpoints/protocol";

// Compose protocol from endpoints - schemas extracted automatically
const authProtocol = protocol({
  name: "Auth",
  initial: "login",
  steps: {
    // fromEndpoint extracts body + query + params → request schema
    // and copies response schema directly. `path` is where the endpoint is
    // served: the step then knows its route.
    login: fromEndpoint(loginHandler, "POST", {
      name: "login",
      path: "/api/auth/login",
    }),

    // fromEndpointMapped creates mapped steps with declarative field mappings
    profile: fromEndpointMapped(profileHandler, "GET", {
      name: "profile",
      path: "/api/auth/profile",
      dependsOn: "login",
      requestMapping: {
        token: fromStep("login", "accessToken"),
      },
    }),

    // fromEndpointDependent creates dependent steps with dynamic schemas
    refresh: fromEndpointDependent(refreshHandler, "POST", {
      name: "refresh",
      path: "/api/auth/refresh",
      dependsOn: "login",
      request: (prev: { refreshToken: string }) =>
        z.object({ refreshToken: z.literal(prev.refreshToken) }),
    }),
  },
});

// Every step knows its route: no route table is needed.
const executor = createHttpExecutor(authProtocol, {
  baseUrl: "https://api.example.com",
});
```

How a step finds its route:

- With `path`, the step carries `{ method, path }`. The file-route form
  (`/api/users/[id]`) is accepted as well as the template (`/api/users/{id}`). A
  path parameter the endpoint does not declare in `params` is refused when the
  step is created
- Without `path`, the executor looks the step up in `routes` under its
  `operationId`: the one set on the endpoint, or the step name. With `path`, the
  default is the id the route generator derives for that path and method
  (`POST /api/auth/login` is `authLoginCreate`), so the step also matches a
  generated route table
- `createHttpExecutor()` resolves every step when it is created and fails there,
  naming each step that has no route. `except: ["stepName"]` leaves out steps
  another executor performs

#### Steps that branch on an HTTP status

A real token endpoint answers a bad grant with HTTP 400 and an error body, not
with a 200 that carries a `type` field. An endpoint declares such responses per
status, and a step made from it with `outcome: true` has the outcome of the call
as its response, one variant per declared status:

```typescript
// routes/api/authorize.ts
POST: endpoint({
  body: z.object({ client_id: z.string(), scope: z.string() }),
  response: z.object({ code: z.string() }),
  responses: { 403: z.object({ error: z.literal("access_denied") }) },
  handler: ...,
}),

const authorize = fromEndpoint(authorizeHandler, "POST", {
  name: "authorize",
  path: "/api/authorize",
  outcome: true,
});
// response:
//   | { ok: true; status: number; body: { code: string } }
//   | { ok: false; status: 403; body: { error: "access_denied" } }

const exchange = fromEndpointMapped(tokenHandler, "POST", {
  name: "exchange",
  path: "/api/token",
  outcome: true,
  dependsOn: "authorize",
  // `body.code` is there on the 200 outcome only.
  requestMapping: { code: fromStep("authorize", "body.code") },
});
```

A denied authorization is then a response, not an exception:

```typescript
const { response, session } = await start.execute("authorize", request);
response; // { ok: false, status: 403, body: { error: "access_denied" } }
session.ready("exchange"); // undefined: there is no code to exchange

// In a plan
branch(authorize, (outcome) => outcome.ok, {
  then: exchange,
  else: sequence(),
});
```

- The HTTP executor returns a declared error status as
  `{ ok: false, status,
  body }`. A status the endpoint does not declare is
  still an `HttpError`
- `endpoint()` keeps the declared statuses as literal types, which is what types
  the variants
- `fuzzProtocol()` reads refusals from the status:
  `isRefusal: (_step, response) => !response.ok`

Benefits:

- **Single source of truth**: Schemas defined once in endpoint, composed into
  protocol
- **No duplication**: Change endpoint schema, protocol automatically updates
- **Type-safe**: the step's request type is the endpoint's `body`, `query` and
  `params` merged into one object, and its response type is the endpoint's
  `response`; naming a method the handler does not define is a compile error
- **Backward compatible**: `step()` and `dependentStep()` still work for manual
  definitions

### Fuzzing a Server Against a Protocol

A session keeps a client from calling `exchange` before `authorize`, or from
spending an authorization code twice. It says nothing about the server: whether
it refuses those calls when a client that does not use the types sends them.

`fuzzProtocol()` walks a protocol the way a session allows, with generated
requests, and at every state it reaches it also sends the calls the protocol
forbids there, past the session, straight to the executor:

| Reason              | The call                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| `before-dependency` | a step whose dependency has not run                                                                        |
| `wrong-variant`     | a step whose `when` the earlier response does not meet                                                     |
| `revoked`           | a step whose dependency was revoked; where the step ran before, the request it sent then, again (a replay) |
| `forged`            | an available step, with a request built for another earlier response                                       |

```typescript
import {
  createHttpExecutor,
  formatFuzzReport,
  fuzzProtocol,
} from "@dgellow/typed-endpoints/protocol";

const report = await fuzzProtocol(
  sessions,
  createHttpExecutor(sessions, { baseUrl, routes }),
  {
    seed: 3,
    runs: 15,
    // Where a generated value is not good enough: real credentials.
    requests: {
      login: () => ({ user: "ada", password: process.env.PASSWORD }),
    },
  },
);

assertEquals(report.findings, [], formatFuzzReport(report));
```

A refusal is an error the executor throws (an HTTP error status, with the HTTP
executor). For a server that refuses with a response of its own, such as OAuth's
error variants, `isRefusal: (step, response) => response.type === "error"` says
which responses refuse.

A report names the seed, counts the calls by reason, lists the steps the walks
reached, and carries each finding with the accepted calls that led to it:

```
seed 1, 40 walks
allowed calls: 156/156 accepted
forbidden (before-dependency): 120/120 refused
forbidden (wrong-variant): 42/44 refused
forbidden (revoked): 40/118 refused
forbidden (forged): 71/71 refused
covered: authorize, exchange, refresh, revoke

the server accepted "exchange" (revoked, replayed request), 78 times
  walk 0, after: authorize > exchange
  request: {"grant_type":"authorization_code","code":"code-1","client_id":"y","client_secret":"am"}
  response: {"type":"success","access_token":"access-3","token_type":"Bearer","expires_in":3600}

the server accepted "exchange" (wrong-variant, replayed request), 2 times
  walk 27, after: authorize > exchange > authorize
  request: {"grant_type":"authorization_code","code":"code-1","client_id":"exhkl","client_secret":"qmwwhvb"}
  response: {"type":"success","access_token":"access-4","token_type":"Bearer","expires_in":3600}
```

That is the report for an authorization server that exchanges one code more than
once (`src/protocol/fuzz_test.ts`).

Three kinds of finding:

- `forbidden-accepted`: the server answered a forbidden call as if it were
  allowed. For a credential that is a defect. For a stateless lookup it may be
  the protocol that is stricter than the server needs to be
- `allowed-refused`: the server refused a call the protocol allows. Often the
  protocol is too permissive: a `logout` that does not declare
  `revoking(["login"])` leaves a second `logout` allowed
- `invalid-response`: the response to an allowed call does not fit its schema

Limits:

- A step the server answers the same way in every state cannot be probed. Token
  revocation is one (RFC 7009, section 2.2: the answer is 200 for a token the
  server does not know). Leave it out with `probes: (step) => step !== "revoke"`
- A replay is sent only for a request made for a response that has since been
  revoked, or for one that response renewed. A request made for a response that
  was merely superseded (a second login) may still be good
- An allowed call the server answers with a refusal of its own (an error
  variant) is no finding: a user may deny an authorization. `report.declined`
  counts them by step. A step that should always succeed and is listed there
  says the protocol does not follow the server: a refresh token that rotates
  while the protocol keeps sending the first one shows up as `refresh` declined
- Requests come from `arbitrary()`. A step whose request cannot be generated is
  counted in `report.skipped` and needs an entry in `requests`

Run against the OAuth reference protocol, the fuzzer found a gap in the protocol
itself: `revoke` accepted any string as the token, so a session could believe a
grant revoked while the server kept it alive. The request is now limited to the
current tokens of the grant.

### Values From Schemas

`arbitrary(schema)` returns a value the schema accepts, chosen by a seeded
generator: the same seed gives the same value.

```typescript
import { arbitrary, seededRandom } from "@dgellow/typed-endpoints";

arbitrary(z.object({ id: z.uuid(), tags: z.array(z.string()).max(3) }), {
  seed: 7,
});

// One generator across calls
const random = seededRandom(7);
const first = arbitrary(UserSchema, { random });
const second = arbitrary(UserSchema, { random });
```

It reads the schema's structure and checks (lengths, bounds, `multipleOf`,
string formats, `startsWith`/`endsWith`/`includes`), builds a value, and parses
it with the schema. Constraints it cannot read (`refine()`, a regular
expression) are met by retrying; a schema it cannot satisfy throws
`ArbitraryError` with the path of the part that failed. Recursive schemas end:
past `maxDepth`, optional parts are left out and lists are empty.

### OpenAPI Protocol Extensions

Protocols are exported to the `x-protocols` extension, a list at the root of the
OpenAPI document:

```typescript
import {
  addProtocolToSpec,
  protocolToOpenApi,
} from "@dgellow/typed-endpoints/protocol";

// One protocol as an x-protocols entry
const entry = protocolToOpenApi(oauth2Protocol);

// Or appended to the list of an OpenAPI spec
const spec = await generateOpenApiSpec({ routesDir: "routes/api" });
const specWithProtocol = addProtocolToSpec(spec, oauth2Protocol);
```

The entry for the OAuth reference protocol:

```yaml
x-protocols:
  - name: OAuth2AuthorizationCode
    description: OAuth 2.0 Authorization Code Grant (RFC 6749 Section 4.1)
    initial: authorize
    terminal: [revoke]
    steps:
      - name: authorize
        kind: step
        next: [exchange]
        description: Redirect user to authorization server for authentication
      - name: exchange
        kind: dependent
        dependsOn: authorize
        revokes: [authorize]
        next: [refresh, revoke]
        description: Exchange authorization code for access token
      - name: refresh
        kind: dependent
        dependsOn: exchange
        renews: exchange
        description: Refresh access token using refresh token
      - name: revoke
        kind: dependent
        dependsOn: exchange
        revokes: [exchange]
        description: Revoke access or refresh token
```

What a step entry carries:

| Member        | Meaning                                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------------------------- |
| `kind`        | `step`, `dependent` (request schema computed from a response) or `mapped` (fields forwarded)                    |
| `operationId` | The operation of the same document the step performs, when the step knows it (`fromEndpoint()`)                 |
| `dependsOn`   | The step whose response this one follows                                                                        |
| `sources`     | Every step whose response it reads, when there is one besides `dependsOn`                                       |
| `mappings`    | For a mapped step: `{ field: { step, path } }`, where each forwarded request field comes from                   |
| `revokes`     | Steps whose responses are no longer usable afterwards                                                           |
| `renews`      | The step whose response this step's response takes the place of                                                 |
| `next`        | Steps that read this one's response. Not a transition relation: a step without dependencies can run at any time |

The protocol entry also has `onAbandon` when the protocol names one. Request and
response schemas are not repeated: a step that has an `operationId` refers to
the operation that describes them.

### Future: API Hierarchy for Composition

The generated client provides a clean hierarchical API: `client.auth.login()`,
`client.users.list()`. Protocol composition could mirror this structure,
providing a dual "API hierarchy" for defining protocols from endpoints.

**Current state** - explicit handler imports and method specification:

```typescript
import { handler as loginHandler } from "./routes/api/auth/login.ts";

const authProtocol = protocol({
  steps: {
    login: fromEndpoint(loginHandler, "POST", { name: "login" }),
  },
});
```

**Potential direction** - generated hierarchy that mirrors the client:

```typescript
// tsgen generates api-steps.ts alongside client types
import { apiSteps } from "./generated/api-steps.ts";

const authProtocol = protocol({
  steps: {
    // Mirrors client.auth.login.create() but for composition
    login: apiSteps.auth.login.post(),
    refresh: apiSteps.auth.refresh.post().dependsOn("login", (prev) => ...),
  },
});
```

Or a fluent builder pattern:

```typescript
steps: {
  login: fromEndpoint(loginHandler).post().named("login"),
  refresh: fromEndpoint(refreshHandler).post()
    .named("refresh")
    .dependsOn("login", (prev: { token: string }) => z.object({ ... })),
}
```

The key insight: endpoints, clients, and protocol steps share the same
underlying structure. Generation could produce both the client (for calling
APIs) and a composition API (for defining protocols) from the same route
definitions.

### Future: Build-Time Protocol Validation

TypeScript can't express Σ (dependent pairs), so the `>>` operator is
approximated at runtime. But we don't have to rely only on TypeScript - build
time processes can validate what the type system cannot.

Similar to how tsgen aggregates Fresh routes to generate OpenAPI specs and typed
clients, a build step could validate protocol _usage_:

1. Parse protocol session code (via TS AST or stored metadata)
2. Validate step execution order matches dependency graph
3. Verify request data flows correctly between dependent steps
4. Catch "wrong step called" or "missing dependency" errors at build time

```
protocol usage code → build validator → errors before runtime
```

The user experience stays TypeScript-native. Invalid protocol usage fails at
build time, not runtime. The Σ complexity is hidden - you just get clear errors
if you call steps in the wrong order or pass incompatible data between steps.

### Declarative Field Mappings

The most common pattern in `dependentStep()` is literal field forwarding:
`code: z.literal(prev.code)`. The `mappedStep()` builder expresses this as plain
data, enabling static analysis while preserving runtime literal enforcement:

```typescript
import { fromStep, mappedStep } from "@dgellow/typed-endpoints/protocol";

const exchangeStep = mappedStep({
  name: "exchange",
  dependsOn: "authorize",
  requestMapping: {
    code: fromStep("authorize", "code"), // Statically analyzable
  },
  requestSchema: z.object({
    code: z.string(),
    grant_type: z.literal("authorization_code"),
    client_id: z.string(),
    client_secret: z.string(),
  }),
  response: ExchangeResponseSchema,
});
```

At runtime, mapped fields are replaced with `z.literal(actualValue)` — identical
enforcement to `dependentStep()` with `z.literal()`. The mapping is plain data
that tooling (tsgen, OpenAPI, build-time validation) can inspect without
executing code.

The declaration determines the value, so the caller does not restate it. The
forwarded fields are optional in the request of `execute()` and of a plan; the
session fills in the ones left out from the response they are mapped to:

```typescript
const { session } = await start.execute("authorize", request);
// `code` comes from the response of "authorize"
await session.execute("exchange", {
  grant_type: "authorization_code",
  client_id: "app",
  client_secret: "secret",
});
```

A value that is left out cannot be stale or foreign: after a renewal
(`renewing()`) the field is the renewed value. A forwarded field that is given
is still checked against the earlier response, so existing calls keep working
and a wrong value is refused with `InvalidRequestError` before the executor
runs. A mapped step whose every required field is forwarded takes `{}`
(`src/protocol/forwarded_test.ts`).

**When to use each:**

- `mappedStep()` — literal field forwarding (the common case)
- `dependentStep()` — conditional schemas
  (`if (prev.type !== "success") return z.never()`), derived constraints
  (`.max(prev.totalParts)`), or any logic beyond simple forwarding

**Multi-step references:** `requestMapping` can reference steps other than
`dependsOn`. All referenced steps become implicit dependencies:

```typescript
const finalizeStep = mappedStep({
  name: "finalize",
  dependsOn: "process",
  requestMapping: {
    token: fromStep("auth", "token"), // from auth step
    sessionId: fromStep("process", "id"), // from process step
  },
  requestSchema: z.object({ token: z.string(), sessionId: z.string() }),
  response: z.object({ success: z.boolean() }),
});
```

**Dot-notation paths** for nested response fields:

```typescript
requestMapping: {
  token: fromStep("exchange", "data.access_token"),
}
```

### Branded Types for Step Output Provenance

`generateProtocolTypes()` reads `requestMapping` from `mappedStep()` definitions
and produces TypeScript with branded `StepOutput<T, Step, Field>` types that
enforce field provenance at compile time:

```typescript
import { generateProtocolTypes } from "@dgellow/typed-endpoints";

const types = generateProtocolTypes(oauthProtocol);
// Writes to file or use as string
```

Generated types look like:

```typescript
declare const __brand: unique symbol;
type StepOutput<T, Step extends string, Field extends string> = T & {
  readonly [__brand]: [Step, Field];
};

type AuthorizeResponse = {
  code: StepOutput<string, "authorize", "code">;
  state: StepOutput<string, "authorize", "state">;
};

type ExchangeRequest = {
  code: StepOutput<string, "authorize", "code">; // MUST come from authorize.code
  client_id: string; // any string is fine
};
```

TypeScript then enforces provenance:

```typescript
declare const auth: AuthorizeResponse;

const good: ExchangeRequest = { code: auth.code, ... };   // ✓ correct provenance
const bad1: ExchangeRequest = { code: auth.state, ... };   // ✗ wrong field
const bad2: ExchangeRequest = { code: "hardcoded", ... };  // ✗ no provenance
```

This handles structural constraints ("code must come from authorize.code").
Computed constraints ("code must be uppercase") still need runtime validation
via `dependentStep()`.

### References

- [Container Morphisms for Composable Interactive Systems](https://arxiv.org/abs/2407.16713) -
  André Videla (APLAS 2024)
- [Lenses for Composable Servers](https://arxiv.org/abs/2203.15633) - André
  Videla, Matteo Capucci (2022)
- [Combinators for Bidirectional Tree Transformations](https://doi.org/10.1145/1232420.1232424) -
  Foster, Greenwald, Moore, Pierce, Schmitt (TOPLAS 2007): the lens laws GetPut,
  PutGet and PutPut
- [**Stellar**](https://gitlab.com/avidela/stellar) (TYPES 2025) - Practical
  Idris library for container-based API architecture
- [RFC 6749: OAuth 2.0 Authorization Framework](https://datatracker.ietf.org/doc/html/rfc6749)

---

## Future Exploration

Ideas inspired by academic research in type systems, API design, and formal
methods.

### Extended Protocol Applications

Building on the protocol schema foundation, additional patterns from André
Videla's container morphism research:

**File Session Protocol** (from the APLAS paper):

```typescript
// Write-many-then-close pattern using Kleene star
const fileSession = protocol({
  name: "FileSession",
  initial: "open",
  terminal: ["close"],
  steps: {
    open: step({
      name: "open",
      request: z.object({
        filename: z.string(),
        mode: z.enum(["read", "write"]),
      }),
      response: z.object({ handle: z.string(), size: z.number() }),
    }),
    write: dependentStep({
      name: "write",
      dependsOn: "open",
      request: (prev: { handle: string }) =>
        z.object({
          handle: z.literal(prev.handle), // Must use handle from open
          content: z.string(),
        }),
      response: z.object({ bytesWritten: z.number() }),
    }),
    close: dependentStep({
      name: "close",
      dependsOn: "open",
      request: (prev: { handle: string }) =>
        z.object({ handle: z.literal(prev.handle) }),
      response: z.object({ success: z.boolean() }),
    }),
  },
});
```

**Container Morphisms for Middleware:**

```typescript
// Middleware as morphism composition (f ∘ g ∘ h)
// Each morphism transforms both request (forward) and response (backward)
const handler = compose(
  authMiddleware, // Container morphism: adds user to context
  cacheMiddleware, // Container morphism: adds cache capability
  databaseMiddleware, // Container morphism: adds db connection
  endpoint, // Final handler
);
```

### Resource Protocol Types

Encode valid API operation sequences in the type system, inspired by
[Dependent Types for Safe and Secure Web Programming](https://dl.acm.org/doi/10.1145/2620678.2620683)
(Brady, IFL 2013) and session types research.

```typescript
// Define state machine for resource lifecycle
const taskProtocol = protocol({
  name: "TaskLifecycle",
  initial: "create",
  terminal: ["completed", "cancelled"],
  steps: {
    create: step({ ... }),           // -> created
    start: dependentStep({ ... }),   // created -> running
    complete: dependentStep({ ... }),// running -> completed
    cancel: dependentStep({ ... }),  // created|running -> cancelled
  },
});

// Client gets typed state machine - invalid transitions are compile errors
const task = await client.tasks.create({ name: "build" }); // state: "created"
await task.start();    // valid: created -> running
await task.complete(); // valid: running -> completed
await task.start();    // compile error: no transition from "completed"
```

### Branded Validated Types

Use phantom types to track validation state at compile time, preventing mixing
of validated and unvalidated data. See
[Branded Types in TypeScript](https://tigerabrodi.blog/branded-types-in-typescript).

```typescript
const Email = z.email().brand<"ValidEmail">();
const UserId = z.string().uuid().brand<"UserId">();

function sendEmail(to: z.infer<typeof Email>) { ... }
const userId: UserId = ...;
sendEmail(userId); // compile error: UserId is not assignable to ValidEmail
```

### Effect Tracking

Track side effects in endpoint types, inspired by
[Algebraic Effects and Dependent Types](https://dl.acm.org/doi/10.1145/2544174.2500581)
(Brady) and the [Effect](https://effect.website/) TypeScript library.

```typescript
const secured = endpoint({
  requires: ["auth", "database"], // declare required capabilities
  handler: async (ctx, data, { auth, database }) => {
    const user = auth.getCurrentUser(); // provided by middleware
    return database.query(`SELECT * FROM posts WHERE user_id = ?`, [user.id]);
  },
});
```

### API Evolution Checker

Static analysis to detect breaking changes between API versions, based on
[API Evolution and Compatibility](https://www.researchgate.net/publication/320031017_API_Evolution_and_Compatibility_A_Data_Corpus_and_Tool_Evaluation)
research.

```bash
typed-endpoints diff --old v1/api-types.ts --new v2/api-types.ts

# BREAKING: UsersGetResponse removed required field 'legacyId'
# SAFE: UsersGetResponse added optional field 'avatarUrl'
# BREAKING: UsersPostRequest.email changed from optional to required
```

### Contract Testing Integration

Generate [Pact](https://docs.pact.io/) consumer-driven contracts from endpoint
definitions for microservices testing.

```typescript
await generatePactContract({
  consumer: "web-frontend",
  provider: "users-api",
  routesDir: "routes/api",
  output: "pacts/web-users.json",
});
```

### Refinement Predicates

Encode logical constraints in types verified by SMT solvers, inspired by
[Liquid Types](https://goto.ucsd.edu/~rjhala/liquid/liquid_types.pdf) (Rondon,
Kawaguchi & Jhala, PLDI 2008).

```typescript
const PageNumber = z.number().int().min(1).meta({
  refinement: "n >= 1", // captured in OpenAPI x-refinement
});

const Percentage = z.number().min(0).max(100).meta({
  refinement: "0 <= n <= 100",
});
```

## License

MIT

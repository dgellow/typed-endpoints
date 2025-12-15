# typed-endpoints

Define API endpoints once with Zod schemas. Get runtime validation, OpenAPI
specs, and TypeScript types for free.

## Installation

```sh
deno add jsr:@dgellow/typed-endpoints
```

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
      return Response.json(user);
    },
  }),

  PUT: endpoint({
    summary: "Update user",
    params: z.object({ id: z.string() }),
    body: z.object({
      email: z.string().email(),
      name: z.string().optional(),
    }),
    response: z.object({ success: z.boolean() }),
    async handler(ctx, { params, body }) {
      // body is validated and typed
      await updateUser(params.id, body);
      return Response.json({ success: true });
    },
  }),
});
```

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
  routesDir: "routes/api",
  output: "src/api-types.ts",
});
```

This generates types like:

```typescript
// GET /api/users
export type UsersGetResponse = { id: string; name: string; email: string }[];

// POST /api/users
export type UsersPostRequest = { name: string; email: string };
export type UsersPostResponse = { id: string; name: string; email: string };
```

### Typed Client

Generate a resource-based API interface and use the typed client:

```bash
deno run -A jsr:@dgellow/typed-endpoints/cli -r routes/api -o src/api-types.ts --format client
```

This generates:

```typescript
export interface Api {
  users: {
    list: { response: { id: string; name: string }[] };
    retrieve: { response: { id: string; name: string } };
    create: { body: { name: string }; response: { id: string; name: string } };
    delete: {};
  };
}
```

Use it with the typed client:

```typescript
import { createClient } from "@dgellow/typed-endpoints/client";
import type { Api } from "./api-types.ts";

const client = createClient<Api>("http://localhost:3000");

// All methods are typed
const users = await client.users.list();
const user = await client.users.retrieve("123");
const created = await client.users.create({ name: "Sam" });
await client.users.delete("123");
```

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
  email: z.string().email(),
});

export const handler = createApiHandlers({
  GET: endpoint({
    // cursor.paginated generates both query and response schemas
    ...cursor.paginated({
      item: UserSchema,
      names: { items: "data", cursor: "nextCursor" },
      defaultLimit: 20,
      maxLimit: 100,
    }),
    public: true,
    async handler(ctx, { query }) {
      // query.cursor is string | undefined
      // query.limit is number (with default 20, max 100)
      const users = await getUsers(query.cursor, query.limit);
      return Response.json({
        data: users,
        nextCursor: users.length > 0 ? users.at(-1)?.id : undefined,
      });
    },
  }),
});
```

Available pagination styles:

- `cursor.paginated()` - Cursor-based pagination (opaque cursor string)
- `cursorId.paginated()` - Last-item-ID cursor (like "after" parameter)
- `offset.paginated()` - Offset/limit pagination with total count
- `page.paginated()` - Page number pagination
- `url.paginated()` - URL-based pagination (like GitHub API)

Each style generates appropriate query params and response fields. Supports:

- Custom field names (e.g., `items: "data"`, `cursor: "nextCursor"`)
- Dot-notation for nested response structure: `nextUrl: "links.next"`
- Extra query/response fields via `extraQuery` and `extraResponse`

Pagination metadata is included in:

- Generated TypeScript types (`pagination: { style: "cursor"; ... }`)
- OpenAPI spec (`x-pagination` extension)

### Server-Sent Events (SSE)

Define typed SSE endpoints with `sseEndpoint`:

```typescript
// routes/api/tasks/[id]/events.ts
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

## API

### `createApiHandlers(def)`

Creates Fresh route handlers with automatic request validation.

Each method definition can include:

- `body` - Zod schema for request body (POST/PUT/PATCH)
- `query` - Zod schema for query parameters
- `params` - Zod schema for path parameters
- `response` - Zod schema for response (OpenAPI only)
- `responses` - Additional response schemas by status code
- `handler` - The request handler function
- `public` - Include in OpenAPI spec (default: false)
- `summary` - OpenAPI summary
- `description` - OpenAPI description
- `tags` - OpenAPI tags

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
- `basePath` - API path prefix (default: "/api")
- `headers` - Default headers for all requests
- `fetch` - Custom fetch implementation

Methods:

- `list(options?)` - GET collection
- `retrieve(id, options?)` - GET single resource
- `create(body, options?)` - POST new resource
- `update(id, body, options?)` - PUT resource
- `delete(id, options?)` - DELETE resource
- `subscribe(id?, options?)` - SSE subscription (returns AsyncIterable)

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

Config: Same as cursor, plus `names.total`, `names.totalPages`, `names.pageParam`,
`names.perPageParam`, `defaultPerPage`, `maxPerPage`.

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

### `generateTypes(options)`

Generates TypeScript types from route Zod schemas.

Options:

- `routesDirs` - Directories to scan (default: ["routes/api"])
- `output` - Output file path (if provided, writes to file)
- `config` - Path to deno.json (needed when routes use import map aliases)

Returns the generated types as a string.

### CLI

```
typed-endpoints - Generate TypeScript types from API route Zod schemas

Options:
  -r, --routes <dir>    Routes directory (can be specified multiple times)
  -o, --output <file>   Output file path (required)
  -f, --format <type>   Output format: "types" or "client" (default: types)
  -c, --config <file>   Path to deno.json (auto-detected if not provided)
  -h, --help            Show help
```

## Architecture

```
src/
├── core/
│   ├── types.ts       # Shared types (including SSE)
│   ├── validation.ts  # Request validation
│   └── openapi.ts     # OpenAPI spec generation (x-pagination)
├── pagination/
│   ├── types.ts       # Pagination type definitions
│   └── index.ts       # cursor, cursorId, offset, page, url helpers
├── client/
│   ├── index.ts       # Typed HTTP client
│   └── types.ts       # Client type definitions
├── tsgen/             # TypeScript type generation (pagination metadata)
├── adapters/
│   └── fresh.ts       # Fresh adapter (endpoint, sseEndpoint)
├── vite-plugin.ts     # Build-time OpenAPI generation
└── cli.ts             # CLI for type generation
```

## Future Exploration

Ideas inspired by academic research in type systems, API design, and formal methods:

### Resource Protocol Types

Encode valid API operation sequences in the type system, inspired by
[Dependent Types for Safe and Secure Web Programming](https://dl.acm.org/doi/10.1145/2620678.2620683)
(Brady, IFL 2013) and session types research.

```typescript
// Define state machine for resource lifecycle
const taskProtocol = protocol({
  states: ["created", "running", "completed"],
  transitions: {
    "created -> running": "POST /tasks/:id/start",
    "running -> completed": "POST /tasks/:id/complete",
  }
});

// Client gets typed state machine - invalid transitions are compile errors
const task = await client.tasks.create({ name: "build" }); // state: "created"
await task.start();    // valid: created -> running
await task.complete(); // valid: running -> completed
await task.start();    // compile error: no transition from "completed"
```

### Branded Validated Types

Use phantom types to track validation state at compile time, preventing mixing of
validated and unvalidated data. See
[Branded Types in TypeScript](https://tigerabrodi.blog/branded-types-in-typescript).

```typescript
const Email = z.string().email().brand<"ValidEmail">();
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
  }
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
[Liquid Types](https://goto.ucsd.edu/~rjhala/liquid/liquid_types.pdf)
(Rondon, Kawaguchi & Jhala, PLDI 2008).

```typescript
const PageNumber = z.number().int().min(1).meta({
  refinement: "n >= 1",  // captured in OpenAPI x-refinement
});

const Percentage = z.number().min(0).max(100).meta({
  refinement: "0 <= n <= 100",
});
```

## License

MIT

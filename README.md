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

- `routesDir` - Directory to scan (default: "routes/api")
- `output` - Output file path (if provided, writes to file)

Returns the generated types as a string.

### CLI

```
typed-endpoints - Generate TypeScript types from API route Zod schemas

Options:
  -r, --routes <dir>    Routes directory (default: routes/api)
  -o, --output <file>   Output file path (required)
  -h, --help            Show help
```

## Architecture

```
src/
├── core/
│   ├── types.ts       # Shared types
│   ├── validation.ts  # Request validation
│   └── openapi.ts     # OpenAPI spec generation
├── tsgen/             # TypeScript type generation
├── adapters/
│   └── fresh.ts       # Fresh adapter
├── vite-plugin.ts     # Build-time OpenAPI generation
└── cli.ts             # CLI for type generation
```

## License

MIT

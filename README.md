# typed-endpoints

Define API endpoints once with Zod schemas. Get runtime validation and OpenAPI
spec generation for free.

## Installation

```sh
deno add jsr:@dgellow/typed-endpoints
```

## Usage

### Fresh

```typescript
// routes/api/users/[id].ts
import { createApiHandlers } from "typed-endpoints/fresh";
import { z } from "zod";

export const handler = createApiHandlers({
  GET: {
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
  },

  PUT: {
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
  },
});
```

### OpenAPI Generation

Add the Vite plugin to generate an OpenAPI spec at build time:

```typescript
// vite.config.ts
import { openApiPlugin } from "typed-endpoints";

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

## Architecture

The package uses an adapter pattern for framework support:

```
src/
├── core/
│   ├── types.ts       # Shared types
│   ├── validation.ts  # Framework-agnostic validation
│   └── openapi.ts     # Spec generation
├── adapters/
│   └── fresh.ts       # Fresh adapter
└── vite-plugin.ts     # Build-time generation
```

## License

MIT

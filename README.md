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

### `generateTypes(options)`

Generates TypeScript types from route Zod schemas.

Options:

- `routesDirs` - Directories to scan (default: ["routes/api"])
- `output` - Output file path (if provided, writes to file)
- `config` - Path to deno.json (needed when routes use import map aliases)
- `format` - Output format: "types", "client", or "routes" (default: "types")

Returns the generated types as a string.

### CLI

```
typed-endpoints - Generate TypeScript types from API route Zod schemas

Options:
  -r, --routes <dir>    Routes directory (can be specified multiple times)
  -o, --output <file>   Output file path (required)
  -f, --format <type>   Output format: types, client, or routes (default: types)
  -c, --config <file>   Path to deno.json (auto-detected if not provided)
  -h, --help            Show help

Formats:
  types   - Flat type exports (UsersGetResponse, etc.)
  client  - Resource-based Api interface for createClient()
  routes  - Runtime route metadata for createHttpExecutor()
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
├── protocol/          # Protocol schemas (experimental)
│   ├── types.ts       # Step, DependentStep, MappedStep, Sequence, Protocol types
│   ├── dsl.ts         # Builder functions: step(), dependentStep(), mappedStep(), etc.
│   ├── mapping.ts     # Declarative field mappings: fromStep(), deriveSchemaWithLiterals()
│   ├── client.ts      # Type-safe protocol session client
│   ├── http.ts        # HTTP executor for real endpoint connections
│   ├── compose.ts     # Endpoint composition (fromEndpoint, fromEndpointMapped)
│   ├── typegen.ts     # Branded type generation from protocols
│   ├── oauth.ts       # OAuth 2.0 reference implementation
│   └── index.ts       # Module exports
├── client/
│   ├── index.ts       # Typed HTTP client
│   └── types.ts       # Client type definitions
├── tsgen/             # TypeScript type generation (pagination metadata)
├── integrations/
│   ├── fresh.ts       # Fresh v2 runtime adapter (endpoint, sseEndpoint)
│   └── vite.ts        # Vite build-time plugin (OpenAPI generation)
└── cli.ts             # CLI for type generation
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
- Which steps are available next (via `AvailableSteps<TSteps, TDone>`)

**What we enforce at runtime:**

- The actual dependent typing (e.g., `code` in exchange must equal `code` from
  authorize)
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

// Step 1: Authorization Request (independent step)
const authorizeStep = step({
  name: "authorize",
  request: z.object({
    response_type: z.literal("code"),
    client_id: z.string(),
    redirect_uri: z.string().url().optional(),
    scope: z.string().optional(),
    state: z.string(),
  }),
  response: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("success"),
      code: z.string(),
      state: z.string(),
    }),
    z.object({ type: z.literal("error"), error: z.string() }),
  ]),
});

// Step 2: Token Exchange - REQUEST DEPENDS ON STEP 1 RESPONSE
const exchangeStep = dependentStep({
  name: "exchange",
  dependsOn: "authorize",
  request: (prev) => {
    // Only valid if authorize succeeded
    if (prev.type !== "success") return z.never();
    return z.object({
      grant_type: z.literal("authorization_code"),
      code: z.literal(prev.code), // THE KEY: enforces exact code from step 1
      client_id: z.string(),
      client_secret: z.string(),
    });
  },
  response: z.object({
    access_token: z.string(),
    token_type: z.literal("Bearer"),
    expires_in: z.number(),
    refresh_token: z.string().optional(),
  }),
});

// Step 3: Token Refresh - depends on exchange response
const refreshStep = dependentStep({
  name: "refresh",
  dependsOn: "exchange",
  request: (prev) => {
    if (prev.type !== "success" || !prev.refresh_token) return z.never();
    return z.object({
      grant_type: z.literal("refresh_token"),
      refresh_token: z.literal(prev.refresh_token), // From exchange response
      client_id: z.string(),
    });
  },
  response: z.object({ access_token: z.string(), expires_in: z.number() }),
});

// Complete protocol definition
const oauth2Protocol = protocol({
  name: "OAuth2AuthorizationCode",
  description: "OAuth 2.0 Authorization Code Grant (RFC 6749 Section 4.1)",
  initial: "authorize",
  terminal: ["revoke"],
  steps: {
    authorize: authorizeStep,
    exchange: exchangeStep,
    refresh: refreshStep,
  },
});
```

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
| `branch()`        | Conditional             | Branch based on predicate                     |
| `parallel()`      | Tensor (⊗)              | Concurrent execution                          |

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
- **OpenAPI x-protocol extension** for spec generation

### Type-Safe Protocol Client

The protocol client enforces valid step sequences at compile time. After
executing a step, TypeScript knows which steps become available:

```typescript
import {
  createMockExecutor,
  createSession,
} from "@dgellow/typed-endpoints/protocol";

// Create a session for the protocol
const executor = createMockExecutor(oauth2Protocol, {
  authorize: { type: "success", code: "auth-code-123", state: "random" },
  exchange: { type: "success", access_token: "token-xyz", ... },
});

const session = createSession(oauth2Protocol, executor);

// Execute steps - TypeScript tracks which are available
const { response: auth, session: s1 } = await session.execute("authorize", {
  response_type: "code",
  client_id: "my-client",
  state: "random",
});

if (auth.type === "error") {
  // TypeScript knows: only "authorize" is available (can retry)
  // s1.execute("exchange", ...) would be a compile error!
  return;
}

// After successful authorize, "exchange" is now available
const { response: tokens, session: s2 } = await s1.execute("exchange", {
  grant_type: "authorization_code",
  code: auth.code, // Must match the code from authorize response
  client_id: "my-client",
  client_secret: "secret",
});

// Session tracks all responses with their types
console.log(s2.responses.authorize.code); // typed as string
console.log(s2.responses.exchange.access_token); // typed as string
```

Key features:

- **Compile-time step enforcement**: Can only execute steps whose dependencies
  are satisfied
- **Literal type preservation**: `dependsOn: "authorize"` is preserved as the
  literal `"authorize"`, not widened to `string`
- **Accumulating state**: Session responses are typed as they accumulate
- **Runtime validation**: Request/response schemas are validated at runtime

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

- **Route mapping**: Steps map to HTTP endpoints via `operationId`
- **Auth propagation**: Automatically inject tokens from previous step responses
- **Path parameters**: `{userId}` in paths resolved from request object
- **Error handling**: `HttpError` class with status, statusText, and body

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
    // and copies response schema directly
    login: fromEndpoint(loginHandler, "POST", { name: "login" }),

    // fromEndpointMapped creates mapped steps with declarative field mappings
    profile: fromEndpointMapped(profileHandler, "GET", {
      name: "profile",
      dependsOn: "login",
      requestMapping: {
        token: fromStep("login", "accessToken"),
      },
    }),

    // fromEndpointDependent creates dependent steps with dynamic schemas
    refresh: fromEndpointDependent(refreshHandler, "POST", {
      name: "refresh",
      dependsOn: "login",
      request: (prev: { refreshToken: string }) =>
        z.object({ refreshToken: z.literal(prev.refreshToken) }),
    }),
  },
});

// Use with HTTP executor as before
const executor = createHttpExecutor(authProtocol, {
  baseUrl: "https://api.example.com",
  routes: apiRoutes,
});
```

Benefits:

- **Single source of truth**: Schemas defined once in endpoint, composed into
  protocol
- **No duplication**: Change endpoint schema, protocol automatically updates
- **Type-safe**: TypeScript infers request/response types from endpoint
  `__apiDef`
- **Backward compatible**: `step()` and `dependentStep()` still work for manual
  definitions

### OpenAPI Protocol Extensions

Export protocols to OpenAPI `x-protocol` extension format:

```typescript
import {
  addProtocolToSpec,
  protocolToOpenApi,
} from "@dgellow/typed-endpoints/protocol";

// Convert protocol to x-protocol format
const xProtocol = protocolToOpenApi(oauth2Protocol);

// Or add directly to an OpenAPI spec
const spec = await generateOpenApiSpec({ routesDir: "routes/api" });
const specWithProtocol = addProtocolToSpec(spec, oauth2Protocol);
```

Generated x-protocol extension:

```yaml
x-protocol:
  name: OAuth2AuthorizationCode
  description: OAuth 2.0 Authorization Code Grant (RFC 6749 Section 4.1)
  initial: authorize
  terminal: [revoke]
  steps:
    - name: authorize
      description: Redirect user to authorization server for authentication
      next: [exchange]
    - name: exchange
      dependsOn: authorize
      description: Exchange authorization code for access token
      next: [refresh, revoke]
    - name: refresh
      dependsOn: exchange
      description: Refresh access token using refresh token
    - name: revoke
      dependsOn: exchange
      description: Revoke access or refresh token
```

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
  Videla (2022)
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
      request: (prev) =>
        z.object({
          handle: z.literal(prev.handle), // Must use handle from open
          content: z.string(),
        }),
      response: z.object({ bytesWritten: z.number() }),
    }),
    close: dependentStep({
      name: "close",
      dependsOn: "open",
      request: (prev) => z.object({ handle: z.literal(prev.handle) }),
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

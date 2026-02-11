# Project: typed-endpoints

Research project exploring how far TypeScript's type system can go for HTTP
APIs. We push boundaries — dependent types via Zod, protocol state machines,
container morphisms — but the implementation and design quality bar is high.
Experimental does not mean sloppy.

## Tech

- **Runtime**: Deno
- **Validation**: Zod v4
- **Framework**: Fresh v2
- **Package**: `@dgellow/typed-endpoints` on JSR

## Commands

Always use the scripts, not bare `deno` commands (they set required
permissions):

- `./scripts/test` — run all tests
- `./scripts/test --update` — update snapshots
- `./scripts/lint` — check formatting (`deno fmt --check`), lint (`deno lint`),
  and type-check (`deno check`)
- `./scripts/format` — auto-format
- `./scripts/build` — build

## Project Structure

```
src/
├── core/           # Shared types, request validation, OpenAPI generation
├── integrations/   # Framework integrations (Fresh v2 runtime, Vite build-time)
├── client/         # Typed HTTP client
├── protocol/       # Multi-step protocol DSL (experimental)
│   ├── types.ts    # Step, DependentStep, MappedStep, composition types
│   ├── dsl.ts      # Builders: step(), dependentStep(), mappedStep()
│   ├── mapping.ts  # Declarative field mappings: fromStep()
│   ├── client.ts   # Type-safe session execution
│   ├── http.ts     # HTTP executor for real endpoints
│   ├── openapi.ts  # x-protocol OpenAPI extension
│   ├── compose.ts  # Endpoint composition (fromEndpoint, fromEndpointMapped)
│   ├── typegen.ts  # Branded type generation from protocols
│   └── oauth.ts    # OAuth 2.0 reference implementation
├── pagination/     # Cursor, offset, page, URL pagination helpers
├── tsgen/          # TypeScript type generation from routes
├── cli.ts          # CLI entry point
└── mod.ts          # Main module exports
e2e_tests/          # End-to-end tests (protocol flows, Fresh server)
```

## Testing

- Deno native test runner (`Deno.test`)
- Assertions from `@std/assert` (`assertEquals`, `assertRejects`)
- Snapshots from `@std/testing/snapshot` (`assertSnapshot`)
- Test files use `_test.ts` suffix, colocated with source
- E2E tests in `e2e_tests/`

## Conventions

- Import map aliases: `@/` maps to `./src/`
- All interfaces use `readonly` properties
- Step types use `__kind` discriminant for tagged unions
- Type parameters preserve literal types (use `const` generic modifier)
- `// deno-lint-ignore no-explicit-any` where variance compatibility requires it
- Protocol module: `dependentStep()` for dynamic schemas, `mappedStep()` for
  static literal forwarding

## Key Concepts (Protocol Module)

Based on André Videla's container morphisms research. The sequential product
(`>>`) means the request type of step N+1 is a function of the response of step
N. TypeScript can't express dependent types, so:

- **Compile-time**: tracks which step _names_ are done (union type `TDone`)
- **Runtime**: enforces actual value constraints via Zod (`z.literal()`)

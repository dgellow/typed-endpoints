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

## Project Structure

```
src/
├── core/           # Shared types, request validation, OpenAPI generation
│   ├── routes.ts   # Route discovery, path conversion, operationId derivation
│   └── zod_internals.ts # The only reader of schema._zod (def, type, unwrap, optionality)
├── integrations/   # Framework integrations (Fresh v2 runtime, Vite build-time)
├── client/         # Typed HTTP client
│   └── sse.ts      # Incremental text/event-stream parser
├── protocol/       # Multi-step protocol DSL (experimental)
│   ├── types.ts    # Step, DependentStep, MappedStep, composition types
│   ├── dsl.ts      # Builders: step(), dependentStep(), mappedStep(); validateProtocol()
│   ├── mapping.ts  # Declarative field mappings: fromStep()
│   ├── client.ts   # Type-safe session execution
│   ├── errors.ts   # ProtocolError hierarchy thrown by sessions
│   ├── introspect.ts # Zod schema path lookup used by validateProtocol()
│   ├── http.ts     # HTTP executor for real endpoints
│   ├── openapi.ts  # x-protocol OpenAPI extension
│   ├── compose.ts  # Endpoint composition (fromEndpoint, fromEndpointMapped)
│   ├── typegen.ts  # Branded type generation from protocols (+ subprocess helper)
│   └── oauth.ts    # OAuth 2.0 reference implementation
├── pagination/     # Cursor, offset, page, URL pagination helpers
├── tsgen/          # TypeScript type generation from routes
│   ├── zod.ts      # Zod schema -> TypeScript type text
│   ├── extract.ts  # Route import + schema rendering (in-process and subprocess)
│   └── generate.ts # types / client / routes output formats
├── cli.ts          # CLI entry point
└── mod.ts          # Main module exports
e2e_tests/          # End-to-end tests (protocol flows, Fresh server, CLI, Vite)
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
- Schema introspection goes through `src/core/zod_internals.ts`; no other file
  reads `schema._zod`
- Protocol module: `dependentStep()` for dynamic schemas, `mappedStep()` for
  static literal forwarding
- A dependent step names its dependency by reference (`dependsOn: stepObject`)
  and states the responses it can follow with `when`, not with `z.never()`
- Type-level guarantees are tested with `@ts-expect-error`; an unused directive
  fails the type-check

## Key Concepts (Protocol Module)

Based on André Videla's container morphisms research. The sequential product
(`>>`) means the request type of step N+1 is a function of the response of step
N. TypeScript can't express dependent types, so:

- **Compile-time**: tracks which step _names_ are done (union type `TDone`) and
  what is known about their responses (`TSeen`: which variant came back, which
  optional fields have a value). A step that follows one variant is available
  only after `session.ready(step)` or `session.narrow(step, guard)`
- **Runtime**: enforces actual value constraints via Zod (`z.literal()`), and
  the same variant conditions (`when`) for callers that bypass the types

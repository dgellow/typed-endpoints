---
name: dev
description: Guide for working on the typed-endpoints codebase — project structure, commands, conventions, and key concepts
user-invocable: true
allowed-tools: Read, Grep, Glob, Bash
---

# Working on typed-endpoints

## Quick Reference

| Task | Command |
|------|---------|
| Run tests | `./scripts/test` |
| Update snapshots | `./scripts/test --update` |
| Lint (fmt + lint + typecheck) | `./scripts/lint` |
| Auto-format | `./scripts/format` |
| Build | `./scripts/build` |

Always use the scripts, never bare `deno` commands — they set required permissions.

## Project Structure

```
src/
├── core/           # Shared types, request validation, OpenAPI generation
├── integrations/   # Framework integrations (Fresh v2 runtime, Vite build-time)
├── client/         # Typed HTTP client
├── protocol/       # Multi-step protocol DSL (experimental)
├── pagination/     # Cursor, offset, page, URL pagination helpers
├── tsgen/          # TypeScript type generation from routes
├── cli.ts          # CLI entry point
└── mod.ts          # Main module exports
e2e_tests/          # End-to-end tests (protocol flows, Fresh server, CLI, Vite)
```

## Tech Stack

- **Runtime**: Deno
- **Validation**: Zod v4
- **Framework**: Fresh v2
- **Package**: `@dgellow/typed-endpoints` on JSR
- **Tests**: `Deno.test` + `@std/assert` + `@std/testing/snapshot`

## Conventions

- Import map aliases: `@/` maps to `./src/`
- All interfaces use `readonly` properties
- Step types use `__kind` discriminant for tagged unions
- Type parameters preserve literal types (use `const` generic modifier)
- `// deno-lint-ignore no-explicit-any` where variance compatibility requires it
- Test files use `_test.ts` suffix, colocated with source
- E2E tests go in `e2e_tests/`

## Protocol Module Key Concepts

Based on Andre Videla's container morphisms research. The sequential product (`>>`) means the request type of step N+1 is a function of the response of step N.

- **Compile-time**: tracks which step _names_ are done (union type `TDone`)
- **Runtime**: enforces actual value constraints via Zod (`z.literal()`)
- `step()` — basic step
- `dependentStep()` — dynamic schema (runtime Zod validation)
- `mappedStep()` — static literal forwarding (compile-time branded types)
- `fromStep()` / `fromEndpoint()` / `fromEndpointMapped()` — composition helpers

## Adding New Features

1. Add types in the relevant module's `types.ts`
2. Implement in the module
3. Export from the module's `index.ts`
4. Re-export from `src/mod.ts` if it's part of the public API
5. Add colocated `_test.ts` for unit tests
6. Add `e2e_tests/` test if it involves subprocess/compilation/server behavior
7. Run `./scripts/test` and `./scripts/lint` before considering it done

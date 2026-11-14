# Project: typed-endpoints

Research project exploring how far TypeScript's type system can go for HTTP
APIs. We push boundaries — dependent types via Zod, protocol state machines,
container morphisms — but the implementation and design quality bar is high.
Experimental does not mean sloppy.

## Tech

- **Runtime**: Deno (development, primary), Bun (supported, tested)
- **Validation**: Zod v4
- **Frameworks**: Fresh v2, Bun.serve, Hono, Next.js, SvelteKit, Astro,
  Nitro/h3, plain fetch handlers
- **Package**: `@dgellow/typed-endpoints` on JSR

## Commands

Always use the scripts, not bare `deno` commands (they set required
permissions):

- `./scripts/test` — run all tests
- `./scripts/test --update` — update snapshots
- `./scripts/lint` — check formatting (`deno fmt --check`), lint (`deno lint`),
  and type-check (`deno check`)
- `./scripts/format` — auto-format
- `./scripts/test-bun` — run `e2e_tests/bun` under Bun, against the sources
  installed as a package in a throwaway project (needs `bun`). Runs the Hono and
  h3 integrations inside the real frameworks
- `./scripts/check-framework-types` — type-check the integrations against the
  real Next.js, SvelteKit, Astro, Hono and h3 packages at pinned versions

## Project Structure

```
src/
├── core/           # Shared types, request validation, OpenAPI generation
│   ├── routes.ts   # Route discovery, path conversion, operationId derivation
│   ├── handlers.ts # buildHandlers(), defineIntegration(): validation + SSE for any framework
│   ├── file_routes.ts # loadFileRoutes(), path formatting for routers
│   ├── module_api.ts # readModuleApi(): handler object, per-method exports, default export
│   ├── runtime.ts  # The only place that knows the runtime (Deno subprocess for import maps)
│   ├── zod_internals.ts # The only reader of schema._zod (def, type, checks, unwrap, optionality)
│   ├── arbitrary.ts # arbitrary(schema): a seeded, valid value of any schema
│   ├── dependent.ts # projection(), expansion(): response type depends on the request
│   ├── selection.ts # selection(), selectOf(), parseSelect(): ?select=id,author(name)
│   ├── selection_types.ts # Type-level select-string parser (ParseSelect, Selected, Selection)
│   └── dependent_types.ts # Type-level functions (ResponseFamily, Apply, Resolve); no imports
├── integrations/   # fresh, bun, hono, next, sveltekit, astro, nitro, fetch; vite (build-time)
├── client/         # Typed HTTP client
│   └── sse.ts      # Incremental text/event-stream parser
├── protocol/       # Multi-step protocol DSL (experimental)
│   ├── types.ts    # Step, DependentStep, MappedStep, composition types
│   ├── dsl.ts      # Builders: step(), dependentStep(), mappedStep(); validateProtocol()
│   ├── mapping.ts  # Declarative field mappings: fromStep()
│   ├── client.ts   # Type-safe session execution
│   ├── plan.ts     # PlanOf/ResultOf, runPlan(): runs sequence/repeat/choice/branch/parallel
│   ├── fuzz.ts     # fuzzProtocol(): sends the calls a protocol forbids to an executor
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
e2e_tests/bun/      # Tests run by Bun (`bun:test`); excluded from Deno's tools
e2e_tests/framework-types/ # Compile-only check against the frameworks' types
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
- Published sources run on Deno and Bun: file access through `node:` modules,
  the `Deno` API only in `src/core/runtime.ts`, imports by relative path (no
  `@/` alias, no `@std/`). `src/portability_test.ts` enforces it. On Deno, avoid
  `node:child_process` and `fs.access`: they need `--allow-env` and
  `--allow-sys`
- A handler returns a value (typed by `z.input` of the response schema, parsed
  at runtime, reduced by `projection()`/`expansion()` rules, sent as JSON), a
  `fail(status, body)` for an error the endpoint declares in `responses` (typed
  and parsed by the schema declared for that status), or a `Response` (sent
  unchecked). A value or failure body the schema rejects is a 500 and is logged,
  never sent
- A framework integration is a thin wrapper around `core/handlers.ts`
  (`defineIntegration()`). It describes the framework's handler argument by the
  members it reads (no dependency on the framework) and offers a `with…<T>()`
  factory for the framework's real type
- Route modules expose definitions in one of three shapes
  (`core/module_api.ts`): a `handler` object with `__apiDef`, per-method exports
  carrying `__methodDef`, or a default export whose method is in the file name
- Route file layouts are `RouteConvention`s (`core/routes.ts`); generators take
  `convention`. A new integration needs: tests with the documented handler
  arguments, a fixture in the framework's layout, an entry in
  `e2e_tests/framework-types/check.ts`, and a real run if the framework is light
  enough to install in `scripts/test-bun`
- Protocol module: `dependentStep()` for dynamic schemas, `mappedStep()` for
  static literal forwarding
- A dependent step names its dependency by reference (`dependsOn: stepObject`)
  and states the responses it can follow with `when`, not with `z.never()`
- Type-level guarantees are tested with `@ts-expect-error`; an unused directive
  fails the type-check

## Key Concepts (Typed Client)

The `client` format generates the `Api` type and a `routes` value. Types are
erased, so the client needs the value to know a call's HTTP method and path
template; each `Api` method also carries its `path` as a literal type, from
which the client types compute the arguments: the trailing path parameter is the
`id` argument, the others are required in `options.params` (`PathParamNames`,
`TrailingParam`). A catch-all is `{+name}` (RFC 6570 reserved expansion). PUT is
`update`, or `replace` when the path also defines PATCH. Without `routes`, the
client falls back to deriving URLs from property names. End-to-end coverage:
`e2e_tests/client_routes_test.ts`.

## Key Concepts (Declared Error Responses)

`responses: { 404: Schema }` on an endpoint declares error bodies per status.
`endpoint()` keeps the statuses as literal types (`TResponses`, a `const` type
parameter). The client format writes them as `errors` in `Api` and in the route
table; `method.result()` returns a declared status as a value and still throws
`ClientError` for any other. `fromEndpoint(..., { outcome: true })` makes a
step's response `{ ok, status, body }` with one variant per declared status
(`EndpointOutcome`), and the HTTP executor answers those statuses as responses.
End to end: `e2e_tests/error_responses_test.ts`,
`e2e_tests/protocol_outcome_test.ts`.

## Key Concepts (Pagination)

A pagination helper (`cursor.paginated()` and four more) returns the query
schema, the response schema, the metadata (`__pagination`) and a `page()`
builder that is not enumerable, so spreading the result into `endpoint()` copies
schemas and metadata only. The client format writes the metadata into the route
table; `list.pages()` / `list.items()` read it there and ask for the next page
by style (`nextPage()` in `client/index.ts`). End to end, one endpoint per
style: `e2e_tests/pagination_test.ts`.

## Key Concepts (Request-Dependent Responses)

A response type can be a function of the request (`?fields=`, `?expand=`).
TypeScript has no type-level lambda, so the function is an interface whose
`response` member refers to `this["request"]` (`ResponseFamily`), applied by
intersection (`Apply`). A schema built by `projection()` / `expansion()` is the
type that holds for every request and carries the rule; the client generator
emits `Dependent<Family, Fallback>` and client methods resolve it against the
`const`-captured options of each call. A claim about a response type is tested
against a live server in `e2e_tests/dependent_response_test.ts`.

A family can also constrain the request (`requires`, collected by `Requires`).
`Selection` parses a select string with template literal types and requires a
`SelectError<reason>` parameter when it does not fit, which makes an unknown
field a compile error at the call. The type-level parser and the runtime parser
(`parseSelect()`) are kept in agreement by tests that check one literal against
both (`src/core/selection_test.ts`); end to end in
`e2e_tests/selection_test.ts`.

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
- **Plans**: a composition node has a request type (`PlanOf`) and a response
  type (`ResultOf`) by recursion on the node; `runPlan()` interprets it. The
  request to a sequence is `{ first, rest }` with `rest` a function of the first
  result; to a repetition, `undefined` or `{ next, rest }`. No plan member is
  called `then` (a thenable would be called by `await`). `PlanOf` threads what
  is known (`Known`: step name to the type its latest response is known to have;
  `After<Node, Known>`) and gives a step that cannot run there the uninhabited
  type `NotReady`. `branch(step, predicate, sides)` names the step it asks about
  and narrows what is known on each side
- **Renewal**: `renewing(step, renewed, combine?)` makes a step's response the
  latest response of `renewed` (refresh-token rotation, cursors). One function,
  `responsesAfter()` in `client.ts`, applies own response, renewal and
  revocation for sessions, plans and the fuzzer. Types: `SeenAfter`, `DoneAfter`
  (session), `Renewed` in `AfterStep` (plan)
- **Fuzzing**: `fuzzProtocol()` walks a protocol with generated requests and
  sends, at every state, the calls forbidden there (`before-dependency`,
  `wrong-variant`, `revoked`, `forged`) to the executor. A forbidden call the
  server accepts is a finding; so is an allowed call it refuses, which usually
  means the protocol under-declares (a missing `revoking`)
- **Revocation**: `revoking(step, names)` removes steps from `TDone`/`TSeen` and
  their responses from the session. The types follow the returned session;
  `createSession(..., { singleUse: true })` refuses the earlier value at runtime

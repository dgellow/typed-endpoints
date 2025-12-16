# Changelog

## 0.1.0-alpha.5

### Features

- add HTTP executor for protocol sessions <details><summary>Details</summary>
  - Add createHttpExecutor() to connect protocols to real HTTP endpoints
  - Add --format routes to CLI for generating route metadata
  - Add operationId to Step/DependentStep for route mapping
  - Support auth token propagation from previous step responses
  - Support path parameter resolution from request objects
  - Add HttpError class for HTTP error handling
  - Update README with HTTP executor documentation
</details>

- add OpenAPI x-protocol extension and comprehensive e2e tests <details><summary>Details</summary>
  - Add protocolToOpenApi() to convert protocols to x-protocol format
  - Add addProtocolToSpec() and addProtocolsToSpec() helpers
  - Move e2e tests from src/adapters/ to e2e_tests/
  - Add protocol e2e tests with real HTTP server integration
  - Add protocol server test demonstrating full flow:
    - Protocol definition with dependent steps
    - HTTP handlers implementing the protocol
    - Protocol session with real HTTP executor
    - Typed client consuming the API
    - OpenAPI spec generation with x-protocol
  - Update README with OpenAPI Protocol Extensions documentation
  - Remove planned Phase 4/5 sections (Phase 4 now implemented)
  - Use snapshot tests for x-protocol output verification<br>
  Total: 225 tests (15 new e2e tests)
</details>

- add type-safe protocol client with compile-time step enforcement <details><summary>Details</summary>
  Phase 3 of the protocol schema DSL. The client tracks which steps have
  been executed and only allows executing steps whose dependencies are
  satisfied - enforced at compile time by TypeScript.<br>
  Key implementation details:
  - ProtocolSession&lt;TSteps, TDone&gt; tracks completed steps in TDone type
  - AvailableSteps&lt;TSteps, TDone&gt; computes which steps can be executed
  - execute() returns new session with TDone | K (state grows)
  - Literal type preservation via minimal constraints and const modifier<br>
  The type system correctly narrows:
  - After authorize succeeds: exchange becomes available
  - After exchange: refresh becomes available
  - Compile error if you try to skip steps<br>
  Tests: 49 protocol tests passing (17 client + 32 OAuth)
</details>

- add protocol schema DSL inspired by container morphisms <details><summary>Details</summary>
  Implements a type-safe DSL for defining multi-step protocols where each
  step's request type can depend on the previous step's response. This is
  a direct implementation of André Videla's Sequential Product (&gt;&gt;) from
  his container morphisms research (APLAS 2024).<br>
  Core primitives:
  - step() - independent request/response (Container)
  - dependentStep() - request derived from previous response (&gt;&gt;)
  - sequence() - sequential composition
  - repeat()/repeat1() - Kleene star/plus (*)
  - choice() - coproduct (+)
  - branch() - conditional
  - parallel() - tensor (⊗)<br>
  Includes OAuth 2.0 Authorization Code Flow as reference implementation
  demonstrating how dependentStep() enforces that exchange.code must be
  the exact value from authorize.response.code at compile time.<br>
  References:
  - Container Morphisms for Composable Interactive Systems (arXiv:2407.16713)
  - Lenses for Composable Servers (arXiv:2203.15633)
</details>

- add typed pagination helpers with OpenAPI support <details><summary>Details</summary>
  Add pagination helpers that generate both query and response schemas:
  - cursor: opaque cursor-based pagination
  - cursorId: last-item-ID pagination (like "after" parameter)
  - offset: offset/limit with total count
  - page: page number pagination
  - url: URL-based pagination (like GitHub API)<br>
  Each helper returns { query, response, __pagination } to spread into
  endpoint(), providing full type safety for paginated endpoints.<br>
  Features:
  - Dot notation support for nested response paths (e.g., "links.next")
  - Custom field names with typed generics for autocomplete
  - Extra query/response fields via extraQuery and extraResponse
  - Pagination metadata in OpenAPI spec via x-pagination extension
  - Pagination metadata in generated TypeScript types
  - End-to-end Fresh 2 tests with real HTTP server
</details>

- add typed Server-Sent Events (SSE) support <details><summary>Details</summary>
  Server-side:
  - Add SseEventDef, SseMethodDef, SseEvent types to core
  - Add sseEndpoint() for defining SSE endpoints with typed events
  - Add createSseResponse() for AsyncGenerator -&gt; text/event-stream<br>
  Client-side:
  - Add subscribe() method to typed client
  - Parse SSE stream as AsyncIterable with typed events
  - Support reconnection with Last-Event-ID and backoff<br>
  Type generation:
  - Generate 'subscribe' method with 'events' object in Api interface
  - Extract SSE event schemas from route files<br>
  Example usage:
    // Server
    sseEndpoint({
      events: { progress: z.object({ percent: z.number() }) },
      async *handler(ctx, validated, signal) {
        yield { event: "progress", data: { percent: 50 } };
      },
    })<br>
    // Client
    for await (const event of client.tasks.subscribe("123")) {
      console.log(event.data.percent);  // typed!
    }
</details>

- add typed HTTP client with resource-based API <details><summary>Details</summary>
  Add createClient&lt;Api&gt;() that provides a typed, Stripe-like interface:
  - client.users.list() -&gt; GET /api/users
  - client.users.retrieve(id) -&gt; GET /api/users/:id
  - client.users.create(body) -&gt; POST /api/users
  - client.users.update(id, body) -&gt; PUT /api/users/:id
  - client.users.delete(id) -&gt; DELETE /api/users/:id
  - Nested resources: client.webhooks.stripe.create()<br>
  Add format: "client" option to generateTypes() for hierarchical Api
  interface generation compatible with createClient.<br>
  New exports: @dgellow/typed-endpoints/client
</details>


### Bug Fixes

- resolve all deno lint issues <details><summary>Details</summary>
  - Fix ban-unused-ignore by moving lint-ignore comments to directly
    precede lines with `any`
  - Fix require-await by using Promise.resolve() instead of async
    functions without await
  - Exclude no-slow-types rule in deno.json (can't be fixed for complex
    Zod types)
  - Add --allow-slow-types to publish workflow for JSR compatibility
  - Add aplas-code to excluded directories
</details>


### Code Refactoring

- consolidate duplicate types and remove dead code <details><summary>Details</summary>
  - Unify StepResponse and ResponseOf into single StepResponse type
    The constraint on StepResponse was redundant - made it permissive
    to work with both strict and minimal type constraints<br>
  - Remove duplicate AnyClientStep (now imports AnyStep from types.ts)<br>
  - Remove dead code: RequestOf type was defined but never used<br>
  - Fix no-op ternary: step.__kind === "step" ? step.response : step.response
    Both branches returned the same value<br>
  - Extract duplicate error formatting to formatZodErrors() helper
    Was duplicated 3 times in validation.ts
</details>


### Documentation

- add André Videla's container morphisms research <details><summary>Details</summary>
  Add section on André Videla's theoretical work that provides the
  categorical foundation for type-safe client-server communication:<br>
  - Container Morphisms for Composable Interactive Systems (2024)
  - Lenses for Composable Servers (2022)
  - Stellar library for API programming in Idris<br>
  His research formalizes the request/response dependency and middleware
  composition that typed-endpoints implements pragmatically in TypeScript.
</details>

- add future exploration section with research-inspired ideas <details><summary>Details</summary>
  Add section documenting potential future features inspired by academic
  research in type systems and formal methods:<br>
  - Resource Protocol Types (session types, dependent types)
  - Branded Validated Types (phantom types)
  - Effect Tracking (algebraic effects)
  - API Evolution Checker (breaking change detection)
  - Contract Testing Integration (Pact)
  - Refinement Predicates (liquid types)<br>
  Each idea includes academic citations and example API designs.
</details>

- add typed client and SSE documentation to README

### Tests

- add comprehensive SSE tests <details><summary>Details</summary>
  Client SSE tests:
  - Event ID parsing
  - Default "message" event type
  - Multiple events in one chunk
  - Non-ok response handling
  - Abort signal cancellation
  - Query params in subscription<br>
  Fresh adapter SSE tests:
  - SSE response format (text/event-stream)
  - Param/query validation for SSE
  - Event ID and retry fields
  - __apiDef includes events (no handler)
  - Mixed REST and SSE endpoints<br>
  Type-level tests:
  - sseEndpoint params/signal inference
  - FreshSseMethodDef generics
</details>


### Chores

- formatting

## 0.1.0-alpha.4

### Features

- support multiple route directories via -r flag
- support multiple route directories via -r flag

### Chores

- fixes
- remove debug console.log from type test

## 0.1.0-alpha.3

### Bug Fixes

- use deno eval instead of use of temp file
- resolve user's import map when generating types via CLI <details><summary>Details</summary>
  When running the CLI from JSR (`deno run jsr:@dgellow/typed-endpoints/cli`),
  dynamic imports couldn't resolve the user's import map aliases (e.g., `zod`).<br>
  Fix: Add --config flag to CLI that spawns a subprocess with the user's
  deno.json config. The subprocess imports route files with the correct
  import map context and converts Zod schemas to type strings before
  returning.<br>
  Also improves type naming: `[id]` now becomes `ById` instead of `Byid`.
</details>


### Chores

- formatting

## 0.1.0-alpha.2

### Bug Fixes

- add defineMethod helper for proper handler type inference <details><summary>Details</summary>
  The previous FreshApiDef type hardcoded z.ZodType | undefined in the
  constraint, which erased specific schema types. Handler validated
  parameters were typed as unknown instead of the inferred Zod types.<br>
  Add defineMethod() helper that gives TypeScript the inference context
  needed to properly type params, body, and query in handler callbacks.
</details>


### Code Refactoring

- rename defineMethod to endpoint <details><summary>Details</summary>
  More descriptive name that better conveys what the function creates.
  Added documentation explaining why the wrapper is needed (TypeScript
  can't infer types between sibling properties in object literals).
</details>


### Chores

- exclude changelog
- formatting

## 0.1.0-alpha.1

### Features

- add typescript types generation

### Chores

- formatting
- formatting

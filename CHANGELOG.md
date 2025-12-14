# Changelog

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

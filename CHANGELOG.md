# Changelog

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

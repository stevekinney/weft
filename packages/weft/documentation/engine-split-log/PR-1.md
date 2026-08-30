# PR-1 — Relocate `src/index.ts` module-level `@example` blocks

**Branch**: `oxlint-strict/pr-1-index-jsdoc`
**Base**: `oxlint-strict/pr-0-config`
**Goal**: Get `src/index.ts` under 500 lines and remove the `/* oxlint-disable max-lines -- ID:index-file-length */` directive.

## Moves made

| Example                                                    | From                                                         | To                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------- |
| "Hello world — email workflow with activity"               | `src/index.ts` module JSDoc (`@example Hello world`)         | `src/core/engine.ts` `Engine` class JSDoc (added as 3rd `@example`)         |
| "Multi-tenant engine — read tenant id from workflow input" | `src/index.ts` module JSDoc (`@example Multi-tenant engine`) | `src/core/tenant.ts` `tenantFromInputField` JSDoc (added as 2nd `@example`) |

## Inventory change

- Removed `index-file-length` entry from `documentation/oxlint-disable-inventory.md`.
- Removed `/* oxlint-disable max-lines -- ID:index-file-length */` from `src/index.ts`.

## Files touched

- `src/index.ts` — removed 2 `@example` blocks and 1 disable directive; replaced with a `@see`-style sentence pointing readers to `Engine` and `tenantFromInputField`
- `src/core/engine.ts` — added "Hello world" example to `Engine` class JSDoc
- `src/core/tenant.ts` — added "Multi-tenant engine" example to `tenantFromInputField` JSDoc
- `documentation/oxlint-disable-inventory.md` — removed `index-file-length` section
- `documentation/engine-split-log/PR-1.md` — this file

## Dependent set

None. PR-2 and later can build on `oxlint-strict/pr-0-config` or branch off this PR independently.

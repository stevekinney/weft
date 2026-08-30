# PR 2: Core types module split

`src/core/types.ts` is now a thin barrel re-export over domain-focused modules in
`src/core/types/`. Existing imports from `src/core/types.ts` continue to work
unchanged while the oversized source file is removed from the oxlint disable
inventory.

## Domain files

| File                                  | Export count |
| ------------------------------------- | -----------: |
| `src/core/types/identity.ts`          |            4 |
| `src/core/types/state.ts`             |            8 |
| `src/core/types/retry-retention.ts`   |            7 |
| `src/core/types/options.ts`           |            6 |
| `src/core/types/workflow-function.ts` |           14 |
| `src/core/types/activity.ts`          |            5 |
| `src/core/types/checkpoint.ts`        |            9 |
| `src/core/types/search-attributes.ts` |            3 |
| `src/core/types/schedules.ts`         |            7 |
| `src/core/types/reviews.ts`           |            3 |
| `src/core/types/bulk.ts`              |            6 |
| `src/core/types/tenants.ts`           |            5 |
| `src/core/types/serializer.ts`        |            1 |
| `src/core/types/constants.ts`         |            6 |

## Compatibility notes

- `src/core/types.ts` keeps the canonical import path by re-exporting all
  domain files.
- Child workflow composition types live in
  `src/core/types/workflow-function.ts` with `WorkflowContext` to avoid a
  runtime module cycle.
- Tenant references now use explicit type-only imports instead of inline import
  expressions inside the split files.

## Removed suppressions

- `core-types-file-length`

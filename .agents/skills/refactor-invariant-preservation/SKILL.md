---
name: refactor-invariant-preservation
description: >-
  Use this skill before refactoring Weft engine, server, storage, worker, or
  agent internals where overload ergonomics, ordering, event sequences, return
  shapes, type-level behavior, or public examples must remain unchanged.
---

# Refactor Invariant Preservation

## When to use

- Refactoring internals behind existing public APIs such as `Engine.create()`, `recoverAll()`, workflow handles, or server operations.
- Changing a multi-phase algorithm where result ordering or event sequencing is observable.
- Modifying TypeScript overloads, default generics, inference helpers, or exported type ergonomics.
- Replacing implementation structure while claiming behavior is unchanged.
- Deduplicating server operation helpers, REST fault shapers, storage helpers, client delegation, or test-support utilities while keeping endpoint contracts unchanged.
- Cleaning up API surface exports, lifecycle overloads, compression framing, visibility filters, or route helpers after review feedback.
- Removing oxlint suppressions or splitting oversized modules while claiming public behavior, type inference, and dispatch ordering are unchanged.
- Removing dead public options or stale deleted-module references after the owning feature has already been removed.
- Removing dead, never-exported helpers while keeping public examples on primitive patterns such as `new URL('./workflow-worker.ts', import.meta.url)`.
- Deduplicating CLI suggestion helpers or generated operation-client type output while claiming user-visible CLI wording, thresholds, or TypeScript inference are unchanged.
- Deduplicating client or handle overload implementations where `.d.ts` emission and call-site inference still require each public class to declare its overloads locally.

## Do not use

- New features that intentionally define new behavior.
- Mechanical renames that cannot affect runtime order, public types, or public examples.
- Test-only cleanup where no production behavior or type surface is touched.

## Workflow

1. Write characterization tests for current public behavior before changing the implementation.
2. Pin observable ordering directly; do not hide ordering changes with sorting unless order is explicitly irrelevant.
3. Add type-level tests for overloads, deferred registration, dynamic names, and inference behavior when TypeScript ergonomics are part of the contract.
4. For REST operation cleanup, preserve the exact legacy status codes, raw or masked error messages, validation envelopes, and route matching behavior unless the task explicitly changes the contract.
5. For worker or operation dispatch cleanup, preserve ownership checks, in-flight persistence-before-send ordering, deadline tracking, and task-result rejection behavior.
6. For compression cleanup, preserve framed payload reads across gzip, brotli, and uncompressed values; never reintroduce headerless compressed payload acceptance unless a task explicitly requires a migration layer.
7. For workflow visibility cleanup, preserve `createdAt desc, id asc` ordering, aggregate truncation/cap behavior, and failure-category projection defaults.
8. Keep test-only helpers in `.test-support.ts` or equivalent test-only files and verify they do not leak into production declarations.
9. For oxlint-suppression retirement, remove the inventory entry only after the directive is gone or replaced by an inline rationale that passes `scripts/check-lint-disables.ts`.
10. Compare documentation examples against the public API after the refactor.
11. Keep compatibility by preserving behavior, not by adding shims or old import paths unless explicitly required.
12. When removing a never-functional public option, delete the field, resolver default, guard tests, and public documentation together; record the breaking removal in `CHANGELOG.md` instead of adding a compatibility shim.
13. For CLI suggestion helper refactors, pin each caller's distance threshold and message text. Top-level subcommands use max distance `2`; `weft api` operation suggestions use max distance `6`; equal-distance candidates keep the first match.
14. For generated operation-client deduplication, change the generator instead of hand-editing `src/cli/generated/operation-client.generated.ts`. Keep repeated aliases structural and internal, prove deterministic regeneration, and add type-level assignability tests for representative bulk-operation inputs.
15. For `LocalClient`, `HttpClient`, `WorkflowHandle`, and `WorkflowHandleDelegation`, do not replace duplicated overload declarations with a shared base unless type-level tests prove emitted declarations and inference remain identical.
16. For `@lostgradient/weft/server` export cleanup, keep `/server` self-sufficient for server option and handle types while leaving `Engine` on the root package. Add internal and built-package `.test-d.ts` assertions instead of relying on JSDoc claims.
17. For RemoteWorker cleanup, preserve the required `workflows` map and qualified activity-name behavior; do not add a compatibility alias for removed `activities`.

## Verification

- Add or update runtime tests for ordering, event sequence, and return shape invariants.
- Add type-level coverage when the refactor changes public TypeScript ergonomics.
- Run focused tests, `bun run typecheck`, and documentation verification when examples changed.
- For generated client cleanup, also run `bun run scripts/generate-operation-client.ts && bun run scripts/check-catalog-drift.ts` and `jscpd` against `src/cli/generated/operation-client.generated.ts`.

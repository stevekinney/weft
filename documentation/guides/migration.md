# Migration Guide

This is the canonical location for per-release migration guidance. When a release changes a public API, storage layout, or wire contract in a backward-incompatible way, the steps for moving existing call sites and data live here, organized by release. See [Breaking Changes](../contributing/breaking-changes.md) for the policy that governs what counts as breaking and what each release must document.

> [!NOTE]
> Weft is pre-1.0, so breaking changes can land between releases without the stability guarantees a 1.0 line would carry. Each release that ships one documents its migration steps here, organized by release.

## 0.3.0

The 0.3.0 release removed the built-in multi-tenancy surface and older workflow-registration compatibility paths. Use the detailed entries in [`CHANGELOG.md`](../../CHANGELOG.md#030---2026-06-06) as the migration checklist:

- Replace built-in tenant resolver, quota, and tenant-claim usage with application-owned scoping on top of `ScopedStorage` or your own authorization layer. Previously tenant-partitioned workflow-shared state is not upgraded in place; plan any state move explicitly.
- Register workflows and activities through the builder definitions: `engine.register(workflow({ name }).execute(handler))` and `engine.register(activity({ name, execute }))`.
- Replace removed agent-loop exports with an external agent framework or application code built on `ctx.run()` and `ctx.review()`.

## 0.1.0

Weft removed the AI agent surface in 0.1.0 and promoted the generic durable-effect and review primitives. If you used the removed agent APIs, migrate the orchestration loop outside Weft and keep Weft responsible for durable workflow execution, activities, and human review.

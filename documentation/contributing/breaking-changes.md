# Breaking-Change and Deprecation Policy

This document defines how Weft manages API stability, communicates breaking changes, and handles the deprecation lifecycle. It applies to the exported public API (the `@lostgradient/weft` package and its sub-path exports) and to the wire contracts (REST, JSON-RPC, WebSocket, storage key layout, persisted-state shape).

## Stability Tiers

Not every Weft surface carries the same stability promise. The tier is stated per feature in the relevant guide. Assume `stable` unless the guide says otherwise.

| Tier             | Guarantee                                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **stable**       | No breaking changes without a deprecation cycle (see below). Removal requires at least one release with a deprecation warning.                               |
| **experimental** | May change or be removed in any release, including patch releases. Experimental surfaces exist to collect real-world feedback before the contract is frozen. |

**Stable surfaces (as of 0.1.x):** `Engine`, `TestEngine`, `SQLiteStorage` (Bun and Node), `LMDBStorage`, `RemoteWorker`, `serve()` and the `/v1/` REST surface, public error classes and `WeftErrorCode`, `WorkflowContext` method signatures, and `ActivityDefinition` fields.

**Experimental surfaces:** Browser runtime, MCP server, `IndexedDBStorage`, `WebExtensionStorage`, `HTTPStorage`, `CompressedStorage`, Turso storage (pending conformance proof), CLI commands beyond `serve` and `doctor`, OTel metric names, externally supplied dashboard mounting, and `ctx.step()` sugar.

## Versioning

Weft uses [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`.

- **Pre-1.0 (`0.x.y`):** Breaking changes to stable surfaces are allowed but always announced in `CHANGELOG.md` with a migration path. The intent is to avoid unnecessary churn — pre-1.0 does not mean "anything goes."
- **Post-1.0:** Breaking changes require a `MAJOR` version bump. `MINOR` adds backwards-compatible features. `PATCH` fixes bugs without changing the API contract.

The project targets `0.2.0` as the next planned release. `1.0.0` requires all Tier-0 correctness work complete, stability-tier documentation in place, and the breaking-change policy frozen.

## What Counts as a Breaking Change

Any change that requires consumers to update call sites, type signatures, configuration, or persisted data is a breaking change.

**API-level breaks:**

- Removing or renaming an exported symbol.
- Changing a function's parameter types or return type in a narrowing or incompatible direction.
- Changing a required property to optional or vice versa in a way that breaks existing callers.
- Narrowing accepted input (e.g., removing an accepted string literal from a union).
- Changing observable behavior under documented inputs.

**Wire-level breaks:**

- Removing or renaming a REST route, JSON-RPC method, or WebSocket message type.
- Changing a required field in a request or response body.
- Changing an HTTP status code for a documented case.
- Changing an error `code` value for any class listed in `WeftErrorCode`.

**Persisted-state breaks:**

- Changing the storage key layout in a way that makes existing records unreadable.
- Adding a required field to a persisted record without a migration or a documented default.
- Changing a checkpoint schema version without providing an upgrade path.

**Not a breaking change:**

- Adding new optional fields to request bodies or response objects.
- Adding new optional parameters to functions.
- Adding new exports to the package.
- Adding new REST routes or JSON-RPC methods.
- Changing an internal (unexported) implementation detail.
- Changing an `experimental` surface in any way.
- Fixing a bug where the documented behavior was correct and the implementation was wrong.

## Deprecation Lifecycle

For stable surfaces, the removal path is:

1. **Deprecation release:** The symbol is marked `@deprecated` in JSDoc with a message explaining the replacement. The `CHANGELOG.md` entry for the release documents the deprecation, what replaces it, and the planned removal timeline.
2. **Minimum one release window:** The deprecated symbol remains functional for at least one release after the deprecation is announced. For pre-1.0, this means the next `0.x` release. Post-1.0 it means the next `MINOR` release.
3. **Removal release:** The symbol is removed. The `CHANGELOG.md` entry lists every removed symbol and links to the deprecation announcement for migration context.

Deprecation is not required before removal in these cases:

- The surface was explicitly marked `experimental`.
- The current release is a `0.x` pre-1.0 release **and** the change is announced in `CHANGELOG.md` with a migration path at least one `0.x` release before removal.
- A security vulnerability requires immediate removal.

## Changelog and Migration

Every release that contains a breaking change must include:

1. A `CHANGELOG.md` entry under `## [version]` with a `### Removed` or `### Changed` section listing each removed or incompatibly changed symbol.
2. A migration path for each removed symbol — what to use instead, or an acknowledgement that there is no direct replacement.
3. If storage or wire contracts change: a migration note explaining how existing data or clients are affected.

The `BREAKING-CHANGES.md` file at the repository root redirects to `documentation/guides/migration.md`, which is the canonical location for per-release migration guides.

## Wire Contract Stability

The stable wire contract covers two sets of routes:

- **Operation routes** exposed externally under `/api/v1/*` (e.g. `/api/v1/workflows`, `/api/v1/activities`). These are cataloged in the OpenAPI/AsyncAPI/OpenRPC specs served at `/openapi.json`, `/asyncapi.json`, and `/openrpc.json`.
- **Root-stable utility routes** at the origin root: `/v1/health`, `/v1/metrics`, `/.well-known/*`, and the spec endpoints listed above.

Changes to any of these follow the same deprecation cycle as API-level changes.

Experimental routes (MCP at `/mcp`, any route documented as experimental) may change without notice.

The storage key layout is internal and not part of the public API contract. However, key-layout changes that break in-place upgrades are documented in the migration guide, and Weft will not silently corrupt existing data on upgrade.

## Questions

If you're unsure whether a proposed change is breaking, open a discussion or PR and ask. The default when in doubt is to treat it as breaking.

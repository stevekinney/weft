# Migration Guide

This is the canonical location for per-release migration guidance. When a release changes a public API, storage layout, or wire contract in a backward-incompatible way, the steps for moving existing call sites and data live here, organized by release. See [Breaking Changes](../contributing/breaking-changes.md) for the policy that governs what counts as breaking and what each release must document.

> [!NOTE]
> Weft is pre-1.0, so breaking changes can land between releases without the stability guarantees a 1.0 line would carry. Each release that ships one documents its migration steps here, organized by release; there are no entries yet because no release so far has required migrating existing call sites or data.

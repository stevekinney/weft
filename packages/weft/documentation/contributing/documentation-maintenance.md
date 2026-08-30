# Documentation Maintenance

The documentation is part of the public API. Keep it tied to executable source, package metadata, and verification scripts instead of treating it as a parallel story.

## Source of Truth

- `package.json` owns the package version, public export map, optional peer dependencies, and minimum Bun runtime.
- `src/index.ts` and subpath entrypoints own the public TypeScript surface.
- `documentation/reference/**` documents the consumer-facing API. Keep it aligned with the exported declarations and JSDoc examples.
- `documentation/guides/**`, `documentation/getting-started/**`, and `README.md` are the user-facing path. Examples here should prefer current public imports and real recovery semantics.
- `reference/**` is architecture and traceability material. Keep it link-valid, but do not force historical sketches or checklist snippets into the runnable markdown doctest set unless the file is promoted into `documentation/**`.
- `documentation/engine-split-log/**` is historical implementation record. Keep links valid and avoid editing it for current API style unless a broken claim is actively confusing readers.

## Verification

Run these before shipping documentation changes:

```bash
bun run verify:documentation
bun run verify:markdown-doctests
bun run verify:jsdoc:full
bun run validate
```

`verify:documentation` checks local Markdown links, heading anchors, Bun version claims, and GitHub workflow Bun pins against `package.json`.

`verify:markdown-doctests` typechecks runnable TypeScript fences under `documentation/**`. Use a bare `ts` or `typescript` fence only for standalone snippets that should compile. Use `ts partial` for fragments that need surrounding setup, and only add a new skip reason when the existing allowlist cannot describe the case.

## Pull Request Evidence Refreshes

When refreshing documentation from recent pull requests, build the evidence set before editing prose. List merged pull requests in the requested window, read the pull request body, changed files, review comments, and verification notes, then update only documentation that reflects shipped behavior on `main`.

For documentation-only refresh pull requests, include an evidence section in the pull request body that names the source pull requests and the specific contracts being documented. The June 2026 worker and restart refresh used this pattern for restart-capable `startOrSignal`, services resolver context, WebSocket frame limits, duplicate `workerId` registration, and browser smoke verification. Do not re-document already-covered behavior when the latest pull request in the window was itself a documentation refresh.

When the requested window contains only a prior documentation refresh, treat that pull request as the new lower bound instead of inventing a README or API-doc change. Record in the next pull request evidence that no post-refresh runtime, API, or workflow behavior landed, and keep public documentation unchanged unless a concrete stale claim remains in `README.md` or `documentation/**`.

## Recovery Examples

Recovery examples should say the durable contract directly:

- Use persistent storage when durability matters. `MemoryStorage` is for tests and ephemeral scripts.
- Register activities and workflows before calling `engine.recoverAll()` or `engine.resume(id)`.
- Use a stable workflow id when rerunning a script should resume an existing workflow. `engine.start()` without `options.id` creates a new workflow.
- Teach activities as named, registered units. Function references are ergonomic locally, but the durable dispatch key is the activity name, especially for remote workers.

## Maintenance Checklist

- Update README links when adding a new primary guide.
- Keep installation and contributor prerequisites in sync with `package.json`.
- Prefer public subpath imports in examples. Do not import from `src/**` in user-facing documentation.
- If a code example changes because the API changed, add or update a doctest, JSDoc example, or verification rule that would catch the same drift next time.

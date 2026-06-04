---
name: verification-loop
description: >-
  Run the full verification cycle before declaring work done: build,
  typecheck, lint, test, export review, diff review. Use when the user
  says "verify", "validate", "check everything passes", "run the full
  suite", "make sure it's ready", or before committing, opening a PR,
  or finishing a feature. Also use proactively after completing any
  non-trivial implementation work.
---

# Verification Loop

Run the full verification cycle before considering any feature, fix, or refactor complete. Each phase catches a different class of problem.

## When to Activate

- After completing a feature or bug fix
- Before creating a commit
- After a refactor that touches multiple files
- When asked to verify or validate changes

## Phases

Run these in order. Fix failures before proceeding to the next phase.

### Phase 1: Build

```bash
bun run build
```

Catches: compilation errors, missing modules, broken imports, declaration generation failures. The build outputs to `dist/` and includes both server (Bun target) and browser (browser target) entrypoints. It also runs the post-build distribution guard that rejects dangling relative `.js` specifiers in `dist/`, including extensionless directory re-export mistakes.

### Phase 2: Typecheck

```bash
bun run typecheck
```

Catches: type errors across the full codebase that the build step may not surface (the build uses `bun build` which is less strict than `tsc`).

### Phase 3: Lint

```bash
bun run lint
```

Catches: style violations, potential bugs, unused imports, promise handling mistakes. Uses Oxlint with type-aware rules and TypeScript/promise/unicorn/import plugins.

When a change adds, removes, or edits `oxlint-disable` directives, also run:

```bash
bun scripts/check-lint-disables.ts
```

The checker enforces the production-source suppression ceiling and the mechanical rationale length floor that `bun run lint` and the pre-commit hook rely on. Full rationale quality still belongs in pull request review.

### Phase 4: Test

```bash
bun test
```

Catches: regressions, broken behavior, incorrect logic. Tests use Bun's native test runner with colocated `.test.ts` files. The pre-commit hook wraps this through `scripts/husky/run-tests.ts` so failures include JUnit-derived testcase summaries and isolation rerun diagnostics; inspect that output before assuming a failure is non-reproducible.

For focused verification during development, run tests for just the affected area:

```bash
bun test src/core        # Core engine tests
bun test src/storage     # Storage backend tests
bun test src/mcp         # MCP transport tests
bun test src/server      # Server API tests
bun test src/testing     # Testing infrastructure tests
```

### Phase 5: Export Review

Check if `src/index.ts` was modified:

```bash
git diff src/index.ts
```

Every addition or removal in `src/index.ts` is a public API change. Verify:

- New exports are intentional and properly typed
- No internal types or implementation details leaked into the public surface
- Removed exports are truly unused by consumers
- Also check the secondary entrypoints: `./service-worker`, `./storage/indexeddb`, `./storage/text-value-store`, `./storage/compressed`, `./server`, `./server/handler`, `./mcp`
- Directory re-exports target explicit `index.ts` paths when they are part of the public root surface; do not rely on the build rewriter to guess a package-consumer contract.

### Documentation Gates

Run these when documentation, examples, generated references, or public declarations changed:

```bash
bun run verify:documentation
bun run verify:markdown-doctests
bun run verify:jsdoc:doctests
```

Use `bun run verify:jsdoc:full` when exported declarations or public JSDoc changed.

When a release changes `package.json` or `src/version.ts`, also run:

```bash
bun run verify:release-version
```

The version gate keeps the package version, exported `VERSION`, and OpenAPI/OpenRPC/AsyncAPI/MCP discovery defaults in sync.

### Package Gates

Run these when package exports, build exclusions, publish workflow, public subpaths, optional dependency isolation, JSDoc examples, or consumer install behavior changed:

```bash
bun run prepack
npm publish --dry-run --ignore-scripts
```

`prepack` is the repository package contract: build, export and portability checks, Markdown and JSDoc doctests, package-content validation, and packed-consumer checks. The publish dry run uses `--ignore-scripts` because the release workflow runs `prepack` explicitly before publishing with ignored package lifecycle scripts.

### Phase 6: Diff Review

```bash
git diff
```

Check for:

- Leftover `console.log` or debug statements
- Unrelated changes that crept in
- Hardcoded values that should be configurable
- `any` types at trust boundaries (server routes, storage interfaces, public API)
- Files that were accidentally modified

## Quick Shortcut

For a single command that covers phases 1-4:

```bash
bun run validate
```

This runs lint + typecheck + test. Follow up with a manual export review and diff review (phases 5-6).

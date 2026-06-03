# Roadmap to 1.0

Weft is launching as `0.2.0` while the final correctness and compatibility contracts settle. A `1.0` release should mean a durable, documented support promise for the stable tier, not just a larger version number.

## What 1.0 Means for Adopters

Version 1.0 means teams can build on the stable tier with a clear compatibility contract:

- Stable-tier APIs follow semver, with migration notes for any breaking change.
- Supported deployment topology is explicit, including the Bun server runtime and the stable storage adapters.
- Stable-tier storage and recovery guarantees are documented at the point of use.
- Public error codes and REST response shapes in the stable tier carry a compatibility commitment.
- Experimental surfaces remain available, but their contracts are labeled separately until they graduate.

## What 1.0 Covers

The 1.0 compatibility promise applies to surfaces that graduate into the stable tier:

- Engine core workflow execution and recovery.
- `TestEngine`.
- [Bun SQLite and SQLite via Node compatibility APIs](reference/api-storage.md#sqlitestorage), plus [LMDB](reference/api-storage.md#lmdbstorage) storage adapters.
- `RemoteWorker`.
- `serve()` and the `/v1` REST surface.
- Source and binary CLI commands `serve`, `doctor`, `version`, `--version`, and `-v`.
- Exported public error codes.

Experimental surfaces can continue changing before they graduate. That includes the browser runtime, MCP, IndexedDB, WebExtension, HTTP and compressed storage, [Turso](reference/api-storage.md#tursostorage) until conformance proof is complete, CLI commands beyond `serve`, `doctor`, `version`, `--version`, and `-v`, OpenTelemetry metric names, externally supplied dashboard mounting, and `ctx.step()` sugar.

## Required Before 1.0

- Tier-0 behavioral contracts are implemented and verified for activity result reconciliation, signal idempotency, resume ownership guarantees for concurrent in-progress workflows, storage durability claims, and persisted-format compatibility.
- The stable-tier list is updated from provisional to final after the Tier-0 work lands.
- Breaking-change and deprecation policy is published.
- Security disclosure process is published.
- Getting-started documentation uses only commands and APIs shipped in the package.
- Launch-blocking regression tests are either passing or replaced by explicit tracked work with owner sign-off.
- The browser surfaces clear the [real-browser promotion gate](#browser-surface-promotion-gate) below.

## Browser-Surface Promotion Gate

The browser adapters (IndexedDB, WebExtension) and the Service Worker runtime stay **experimental** until their real-browser smoke tests are green in a **required** CI gate. Real-browser coverage is the explicit, single criterion that graduates them to stable: green unit tests against a fake IndexedDB or a stubbed `chrome.storage` driver are not sufficient evidence that the durability and lifecycle guarantees hold in an actual browser.

The mechanics are already wired:

- The `browser-smoke` job in [`.github/workflows/ci.yaml`](../.github/workflows/ci.yaml) provisions a pinned Chromium through Playwright (`bunx playwright install --with-deps chromium`) and runs all three real-browser smoke suites — IndexedDB durability, Service Worker lifecycle, and WebExtension storage — under `bun:test` via a single `test:browser-smoke` entry point. Each suite drives that pinned Chromium directly (Playwright supplies the binary; the suites themselves are Bun tests, not `@playwright/test` runs), so `bun:test` stays the sole test runner.
- The job ships **non-blocking** (`continue-on-error: true`) while the tests bake, because newly introduced real-browser tests are flaky and runner browser provisioning varies.

Graduation happens in one explicit step: once `browser-smoke` has been reliably green for roughly two weeks, drop `continue-on-error` so the job becomes a **required** check. The moment a browser surface's smoke coverage is enforced by that required gate, it is eligible to move from the experimental list above into the stable tier. Until then, treat every browser surface as experimental regardless of how its non-browser unit tests look.

## Release Posture

Use the pre-1.0 public MVP line for launch. Breaking changes are still possible before 1.0, but they should be documented in release notes with migration guidance. Use `1.0.0` only when the stable tier can carry the compatibility promise above.

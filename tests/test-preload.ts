/**
 * Bun test preload. Listed under `[test].preload` in `bunfig.toml`, this runs
 * once before any test file in the shared test process.
 *
 * Installs `globalThis.indexedDB` (and the rest of the IndexedDB API) so the
 * storage suites and their fault harness can reach the global without each test
 * file importing the shim itself. Before this, files relied on a sibling test
 * importing `fake-indexeddb/auto` first — order-dependent flakiness that failed
 * only when the runner happened to execute an un-shimmed file first.
 *
 * This lives under `tests/` (not `src/`) on purpose: `fake-indexeddb` is a
 * devDependency and the build's `rootDir` is `./src`, so keeping the preload
 * out of `src/` guarantees it never ships in `dist/`.
 *
 * Test helpers that are NOT test files (e.g.
 * `src/testing/storage-backends.test-support.ts`)
 * still import the shim explicitly: they can be imported from contexts the test
 * preload does not cover, so their dependency must be self-contained.
 *
 * It also installs a single targeted `console.warn` filter (see below) that
 * drops the one intentional-but-noisy production warning every server test
 * triggers, keeping signal warnings visible.
 */
import 'fake-indexeddb/auto';

/**
 * Distinctive fragment of the no-auth posture warning emitted by
 * `assertAuthenticationPosture` in `src/server/serve-internals.ts`. The hundreds
 * of bare `serve({ engine, port: 0 })` calls across the server suites each fire
 * this warning, flooding test output with a single repeated line.
 *
 * We match a stable substring rather than importing the production constant so
 * the preload does not pull the entire server runtime graph (MCP, observability,
 * worker registry) into every test process — including pure storage and codec
 * suites that never touch the server. The substring is pinned against the real
 * constant by a drift-guard test (`tests/auth-warning-filter.test.ts`), so a
 * reworded warning fails loudly instead of silently slipping past the filter.
 */
export const NO_AUTHENTICATION_WARNING_FRAGMENT = 'server started with NO authentication';

/**
 * Whether a `console.warn` call carries the no-auth posture warning. Exported so
 * the drift-guard test (`tests/auth-warning-filter.test.ts`) exercises the exact
 * predicate the wrapper installs, rather than a copy that could silently drift.
 */
export function isSuppressedAuthWarning(args: readonly unknown[]): boolean {
  return typeof args[0] === 'string' && args[0].includes(NO_AUTHENTICATION_WARNING_FRAGMENT);
}

/**
 * Wrap `console.warn` so the known-benign no-auth posture warning is dropped
 * while every other warning passes through untouched. To assert on this warning
 * in a test, use `spyOn(console, 'warn')` (or save and restore `console.warn`
 * directly): either pattern replaces this wrapper for the test's duration, so
 * the assertion observes the call. The filter only suppresses the incidental
 * warnings from servers started without auth as a side effect of other tests.
 */
const originalConsoleWarn = console.warn.bind(console);
console.warn = (...args: Parameters<typeof console.warn>): void => {
  if (isSuppressedAuthWarning(args)) {
    return;
  }
  originalConsoleWarn(...args);
};

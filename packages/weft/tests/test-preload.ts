/**
 * Bun test preload. Listed under `[test].preload` in `bunfig.toml`, this runs
 * once before any test file in the shared test process.
 *
 * Installs `globalThis.indexedDB` (and the rest of the IndexedDB API) so the
 * storage suites and their fault harness can reach the global without each test
 * file importing the polyfill itself. Before this, files relied on a sibling test
 * importing `fake-indexeddb/auto` first — order-dependent flakiness that failed
 * only when the runner happened to execute a file without IndexedDB globals first.
 *
 * This lives under `tests/` (not `src/`) on purpose: `fake-indexeddb` is a
 * devDependency and the build's `rootDir` is `./src`, so keeping the preload
 * out of `src/` guarantees it never ships in `dist/`.
 *
 * Test helpers that are NOT test files (e.g.
 * `src/testing/storage-backends.test-support.ts`)
 * still import the polyfill explicitly: they can be imported from contexts the test
 * preload does not cover, so their dependency must be self-contained.
 *
 * It also installs a targeted `console.warn` filter (see below) that drops the
 * intentional-but-noisy production startup warnings many server tests trigger,
 * keeping signal warnings visible.
 *
 * Finally, it registers a global `afterEach` that restores real timers after
 * every test, so a failed teardown cannot leak a fake clock into later tests
 * (`jest.useFakeTimers()` traps `Bun.sleep`, so a leaked clock hangs the next
 * `Bun.sleep`). Same order-dependent-flakiness rationale as the `fake-indexeddb`
 * preload above.
 */
import { afterEach } from 'bun:test';

import { restoreRealTimers } from '../src/testing/fake-timers.test-support.ts';

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
export const MCP_ORIGIN_CONFIGURATION_WARNING_FRAGMENT =
  'MCP HTTP transport is enabled without publicOrigin or trustedHosts';

const SUPPRESSED_WARNING_FRAGMENTS = [
  NO_AUTHENTICATION_WARNING_FRAGMENT,
  MCP_ORIGIN_CONFIGURATION_WARNING_FRAGMENT,
] as const;

/**
 * Whether a `console.warn` call carries a known startup posture warning.
 * Exported so the drift-guard test (`tests/auth-warning-filter.test.ts`)
 * exercises the exact predicate the wrapper installs, rather than a copy that
 * could silently drift.
 */
export function isSuppressedStartupWarning(args: readonly unknown[]): boolean {
  return (
    typeof args[0] === 'string' &&
    SUPPRESSED_WARNING_FRAGMENTS.some((fragment) => args[0].includes(fragment))
  );
}

/**
 * Wrap `console.warn` so known-benign startup posture warnings are dropped
 * while every other warning passes through untouched. To assert on this warning
 * in a test, use `spyOn(console, 'warn')` (or save and restore `console.warn`
 * directly): either pattern replaces this wrapper for the test's duration, so
 * the assertion observes the call. The filter only suppresses incidental
 * startup warnings from servers created as a side effect of other tests.
 */
const originalConsoleWarn = console.warn.bind(console);
console.warn = (...args: Parameters<typeof console.warn>): void => {
  if (isSuppressedStartupWarning(args)) {
    return;
  }
  originalConsoleWarn(...args);
};

/**
 * Global safety net: after every test, restore real timers if a test left the
 * fake clock installed. `restoreRealTimers()` is a no-op (guarded by
 * `jest.isFakeTimers()`) when timers were never faked or a file already restored
 * them, so this never interferes with a well-behaved test — it only prevents a
 * leaked fake clock from one file from hanging `Bun.sleep` in the next. No file
 * installs fake timers in `beforeAll` (every install is per-`it`/`beforeEach`),
 * so restoring between tests cannot strip a clock a test still depends on.
 */
afterEach(() => {
  restoreRealTimers();
});

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
 */
import 'fake-indexeddb/auto';

import { $ } from 'bun';
import sveltePlugin from 'bun-plugin-svelte';

await $`rm -rf dist`;

// Node/Bun target — main bundle + per-backend storage submodules.
// Heavy backends (lmdb, @libsql/client) are externalized so consumers
// only pay for what they actually import.
await Bun.build({
  entrypoints: [
    './src/index.ts',
    // Storage submodule entry points (one per subpath export)
    './src/storage/interface.ts',
    './src/storage/memory.ts',
    './src/storage/compressed-storage.ts',
    './src/storage/scoped-storage.ts',
    './src/storage/typed-storage.ts',
    './src/storage/resolve.ts',
    './src/storage/lmdb.ts',
    './src/storage/turso.ts',
    './src/storage/node-sqlite.ts',
    './src/storage/auto.ts',
    './src/testing/index.ts',
    './src/worker/protocol.ts',
    './src/mcp/index.ts',
    './src/mcp/cli.ts',
    './src/observability/index.ts',
    './src/json-schema.ts',
    // Bun-only server subpath (weft/server)
    './src/server/index.ts',
  ],
  outdir: './dist',
  target: 'bun',
  format: 'esm',
  root: './src',
  naming: '[dir]/[name].js',
  sourcemap: 'external',
  minify: true,
  external: ['lmdb', '@libsql/client', '@opentelemetry/api', 'bun:sqlite', 'better-sqlite3'],
});

// Keep the storage barrel as local binding re-exports. Bun 1.3.13 can
// incorrectly strip imported bindings that are only used by a bundled barrel
// export list, so this mirrors the workaround in src/storage/index.ts.
await Bun.write(
  './dist/storage/index.js',
  `import { KEYS, storageConditionalBatch, storageValuesEqual } from './interface.js';
import { MemoryStorage } from './memory.js';
import { resolveStorage } from './resolve.js';
import { ScopedStorage, scopedStorage } from './scoped-storage.js';
import { jsonCodec, msgpackCodec, withCodec } from './typed-storage.js';

const exportedJsonCodec = jsonCodec;
const exportedKeys = KEYS;
const exportedMemoryStorage = MemoryStorage;
const exportedMsgpackCodec = msgpackCodec;
const exportedResolveStorage = resolveStorage;
const exportedScopedStorage = ScopedStorage;
const exportedScopedStorageFactory = scopedStorage;
const exportedStorageConditionalBatch = storageConditionalBatch;
const exportedStorageValuesEqual = storageValuesEqual;
const exportedWithCodec = withCodec;

export {
  exportedJsonCodec as jsonCodec,
  exportedKeys as KEYS,
  exportedMemoryStorage as MemoryStorage,
  exportedMsgpackCodec as msgpackCodec,
  exportedResolveStorage as resolveStorage,
  exportedScopedStorage as ScopedStorage,
  exportedScopedStorageFactory as scopedStorage,
  exportedStorageConditionalBatch as storageConditionalBatch,
  exportedStorageValuesEqual as storageValuesEqual,
  exportedWithCodec as withCodec,
};
`,
);
await $`rm -f dist/storage/index.js.map`;

// Preserve runtime constructor names for package export-condition smoke tests.
await Bun.build({
  entrypoints: ['./src/storage/bun-sql.ts', './src/storage/node-sqlite.ts'],
  outdir: './dist',
  target: 'bun',
  format: 'esm',
  root: './src',
  naming: '[dir]/[name].js',
  sourcemap: 'external',
  minify: false,
  external: ['bun:sqlite', 'better-sqlite3'],
});

// Browser entrypoints (Service Worker, IndexedDB, handler)
await Bun.build({
  entrypoints: [
    './src/service-worker/index.ts',
    './src/storage/indexeddb.ts',
    './src/storage/web-extension.ts',
    // HTTPStorage is portable and intentionally emitted from the browser build
    // so the subpath is produced once without a later overwrite.
    './src/storage/http.ts',
    './src/server/handler.ts',
  ],
  outdir: './dist',
  target: 'browser',
  format: 'esm',
  naming: '[dir]/[name].js',
  sourcemap: 'external',
  minify: true,
});

// Dashboard (Svelte SPA for /ui)
await Bun.build({
  entrypoints: ['./src/dashboard/index.html'],
  outdir: './dist/dashboard',
  target: 'browser',
  minify: true,
  sourcemap: 'external',
  plugins: [sveltePlugin],
});

await $`bunx tsc --declaration --emitDeclarationOnly --project tsconfig.build.json`;

console.log('Build complete!');

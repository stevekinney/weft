import { $ } from 'bun';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import chalk from 'chalk';

import {
  assertNoTestOnlyDependenciesInDist,
  assertRelativeImportsResolveInDist,
  assertSingletonModulesNotDuplicated,
} from './lib/build-guards.ts';

await $`rm -rf dist`;

const typescriptTranspiler = new Bun.Transpiler({ loader: 'ts', target: 'bun' });

/**
 * Map an extensionless relative specifier to the `.js` path the unbundled
 * runtime build emits. A specifier pointing at a directory (e.g. `./diagnostics`
 * whose entry is `diagnostics/index.ts`) must become `./diagnostics/index.js`,
 * not `./diagnostics.js` — otherwise the consumer hits "Cannot find module".
 * The source file's path anchors the resolution so we can tell a directory
 * import apart from a sibling-module import on disk.
 */
function relativeSpecifierToJavaScript(sourcePath: string, specifier: string): string {
  const withoutTypeScriptExtension = specifier.endsWith('.ts') ? specifier.slice(0, -3) : specifier;
  const absoluteTarget = resolve(dirname(sourcePath), withoutTypeScriptExtension);
  // A bare directory import resolves to its `index.ts`; emit `/index.js`.
  if (!existsSync(`${absoluteTarget}.ts`) && existsSync(`${absoluteTarget}/index.ts`)) {
    return `${withoutTypeScriptExtension}/index.js`;
  }
  return `${withoutTypeScriptExtension}.js`;
}

function rewriteRelativeJavaScriptSpecifiers(sourcePath: string, source: string): string {
  return source
    .replace(/from (["'])(\.\.?\/[^"']+)\1/g, (match, quote: string, specifier: string) => {
      if (/\.(js|json|html|css)$/.test(specifier)) return match;
      return `from ${quote}${relativeSpecifierToJavaScript(sourcePath, specifier)}${quote}`;
    })
    .replace(/import\((["'])(\.\.?\/[^"']+)\1\)/g, (match, quote: string, specifier: string) => {
      if (/\.(js|json|html|css)$/.test(specifier)) return match;
      return `import(${quote}${relativeSpecifierToJavaScript(sourcePath, specifier)}${quote})`;
    });
}

async function writeUnbundledRuntimeModules(): Promise<void> {
  const sourceGlob = new Bun.Glob('src/**/*.ts');

  for await (const sourcePath of sourceGlob.scan('.')) {
    if (
      sourcePath.endsWith('.test.ts') ||
      sourcePath.endsWith('.test-d.ts') ||
      sourcePath.endsWith('.test-support.ts') ||
      sourcePath.endsWith('.bench.ts') ||
      sourcePath.endsWith('-fixture.ts') ||
      sourcePath.startsWith('src/benchmarks/') ||
      sourcePath.startsWith('src/workers/test-') ||
      sourcePath.includes('/__tests__/') ||
      sourcePath.includes('/__fixtures__/')
    ) {
      continue;
    }

    const outputPath = sourcePath.replace(/^src\//, 'dist/').replace(/\.ts$/, '.js');
    const sourceText = await Bun.file(sourcePath).text();
    const transformed = typescriptTranspiler.transformSync(sourceText);
    const rewritten = rewriteRelativeJavaScriptSpecifiers(sourcePath, transformed);
    // `Bun.Transpiler` strips a leading shebang line (verified: `#!/usr/bin/env
    // bun\n\nconsole.log(1)` transpiles to just `console.log(1)`), which would
    // silently ship non-executable `bin` entries like cli-main.ts/mcp/cli.ts.
    // Restore it so those files stay both executable AND on this unbundled
    // path — required so they resolve the same on-disk singleton modules
    // (core/engine/internals.ts, core/codec/serializer-registry.ts,
    // core/context/internals.ts) as everything else the process might load,
    // including a dynamically `import()`ed user workflow module that pulls in
    // the root `@lostgradient/weft` package itself (see #710).
    const shebangMatch = /^#!.*\n/.exec(sourceText);
    await Bun.write(outputPath, shebangMatch ? shebangMatch[0] + rewritten : rewritten);
  }

  // A `.ts` file can `import` a sibling `.json` file directly (e.g.
  // src/cli/api.ts's generated operation-catalog snapshot). Bundled entry
  // points inline that data at build time, so this only matters for the
  // unbundled tree: copy the JSON verbatim alongside its transpiled `.js`
  // siblings so the real relative import above resolves at runtime instead
  // of throwing "Cannot find module" for a file that was never copied.
  const jsonGlob = new Bun.Glob('src/**/*.json');
  for await (const sourcePath of jsonGlob.scan('.')) {
    if (sourcePath.includes('/__tests__/') || sourcePath.includes('/__fixtures__/')) continue;
    const outputPath = sourcePath.replace(/^src\//, 'dist/');
    await Bun.write(outputPath, Bun.file(sourcePath));
  }
}

// Baseline runtime modules. Specialized builds below overwrite the public
// subpaths that need bundling, minification, browser targeting, or constructor
// name preservation.
await writeUnbundledRuntimeModules();

// Node/Bun target — per-backend storage and integration submodules.
// Heavy backends (lmdb, @libsql/client, @neondatabase/serverless) are
// externalized so consumers only pay for what they actually import.
//
// Entrypoints that transitively reach a module-scope singleton registry
// (currently `core/engine/internals.ts`, `core/codec/serializer-registry.ts`,
// and `core/context/internals.ts` — see SINGLETON_MODULE_MARKERS in
// scripts/lib/build-guards.ts) are deliberately EXCLUDED from this bundle.
// Bundling inlines its own private copy of every module an entrypoint
// imports, including those registries, so a bundled entrypoint ends up with
// its own disconnected `WeakMap`/`Map` instance instead of sharing the one
// the unbundled root tree writes via `writeUnbundledRuntimeModules()` above.
// A consumer that constructs an `Engine` via the root import and hands it to
// a bundled `serve()` (or registers a serializer via the root import and
// encodes through a bundled storage codec) would then hit "internals not
// initialized" or a silently-unregistered serializer — see #710. Leaving
// `server/index.ts`, `testing/index.ts`, and `storage/typed-storage.ts` on
// the unbundled path (already emitted above) means they resolve the exact
// same on-disk singleton modules as root.
//
// `cli-main.ts` and `mcp/cli.ts` (the `weft`/`weft-mcp` bins) are NOT in this
// bundle either, for a second, sharper reason than the entries above: `weft
// serve --workflows <path>` dynamically `import()`s the caller's own
// workflow module in the SAME process, and that module typically imports
// `workflow`/`registerSerializer` from the root `@lostgradient/weft` package
// itself (resolved via node_modules, a genuinely separate module instance
// from anything a bundle would inline). A bundled CLI would leave that
// dynamically-imported module talking to root's singleton registries while
// the CLI's own `Engine`/codec use a disconnected inlined copy — the same
// #710 bug, just inside one process instead of across a library boundary.
// `writeUnbundledRuntimeModules()` restores each file's stripped shebang
// (see above) specifically so these two bins can stay both executable and
// unbundled.
await Bun.build({
  entrypoints: [
    // Storage submodule entry points (one per subpath export)
    './src/storage/interface.ts',
    './src/storage/memory.ts',
    './src/storage/compressed-storage.ts',
    './src/storage/scoped-storage.ts',
    './src/storage/testing.ts',
    './src/storage/resolve.ts',
    './src/storage/lmdb.ts',
    './src/storage/turso.ts',
    './src/storage/neon.ts',
    './src/storage/postgres.ts',
    './src/storage/node-sqlite.ts',
    './src/storage/auto.ts',
    './src/worker/protocol.ts',
    './src/observability/index.ts',
    './src/json-schema.ts',
  ],
  outdir: './dist',
  target: 'bun',
  format: 'esm',
  root: './src',
  naming: '[dir]/[name].js',
  minify: true,
  external: [
    'lmdb',
    '@libsql/client',
    '@neondatabase/serverless',
    'pg',
    '@opentelemetry/api',
    'bun:sqlite',
    'better-sqlite3',
  ],
});

// Keep the MCP public barrel as local binding re-exports. Bun 1.3.13 can
// produce invalid minified output for this barrel when imported from packed
// consumers, so emit the public subpath as plain ESM.
await Bun.write(
  './dist/mcp/index.js',
  `import {
  anonymousPrincipal,
  principalFromApiKey,
  principalFromJwtClaims,
  principalFromMutualTls,
  principalFromStdioLocal,
} from '../server/principal.js';
import { handleMcpHttpRequest } from './http.js';
import { DEFAULT_MCP_MAX_BODY_BYTES, MCP_PROTOCOL_VERSION } from './protocol.js';
import { McpSession, McpSessionManager, createMcpSessionManager } from './session.js';
import { runMcpStdioSession } from './stdio.js';

export {
  anonymousPrincipal,
  createMcpSessionManager,
  DEFAULT_MCP_MAX_BODY_BYTES,
  handleMcpHttpRequest,
  MCP_PROTOCOL_VERSION,
  McpSession,
  McpSessionManager,
  principalFromApiKey,
  principalFromJwtClaims,
  principalFromMutualTls,
  principalFromStdioLocal,
  runMcpStdioSession,
};
`,
);

// Keep the storage barrel as local binding re-exports. Bun 1.3.13 can
// incorrectly strip imported bindings that are only used by a bundled barrel
// export list, so this mirrors the workaround in src/storage/index.ts.
await Bun.write(
  './dist/storage/index.js',
  `import {
  assertDurableStorageForRecovery,
  KEYS,
  requireStorageCapability,
  storageConditionalBatch,
  storageValuesEqual,
  WEFT_RESERVED_KEY_PREFIXES,
} from './interface.js';
import { storageDeleteRange } from './delete-range.js';
import { MemoryStorage } from './memory.js';
import { resolveStorage } from './resolve.js';
import { ScopedStorage, scopedStorage } from './scoped-storage.js';
import { copyTextKeyValueRowsToStorage } from './text-value-import.js';
import { textValueStore } from './text-value-store.js';
import { jsonCodec, msgpackCodec, withCodec } from './typed-storage.js';

const exportedAssertDurableStorageForRecovery = assertDurableStorageForRecovery;
const exportedCopyTextKeyValueRowsToStorage = copyTextKeyValueRowsToStorage;
const exportedJsonCodec = jsonCodec;
const exportedKeys = KEYS;
const exportedMemoryStorage = MemoryStorage;
const exportedMsgpackCodec = msgpackCodec;
const exportedRequireStorageCapability = requireStorageCapability;
const exportedResolveStorage = resolveStorage;
const exportedScopedStorage = ScopedStorage;
const exportedScopedStorageFactory = scopedStorage;
const exportedStorageConditionalBatch = storageConditionalBatch;
const exportedStorageDeleteRange = storageDeleteRange;
const exportedStorageValuesEqual = storageValuesEqual;
const exportedTextValueStore = textValueStore;
const exportedWeftReservedKeyPrefixes = WEFT_RESERVED_KEY_PREFIXES;
const exportedWithCodec = withCodec;

export {
  exportedAssertDurableStorageForRecovery as assertDurableStorageForRecovery,
  exportedCopyTextKeyValueRowsToStorage as copyTextKeyValueRowsToStorage,
  exportedJsonCodec as jsonCodec,
  exportedKeys as KEYS,
  exportedMemoryStorage as MemoryStorage,
  exportedMsgpackCodec as msgpackCodec,
  exportedRequireStorageCapability as requireStorageCapability,
  exportedResolveStorage as resolveStorage,
  exportedScopedStorage as ScopedStorage,
  exportedScopedStorageFactory as scopedStorage,
  exportedStorageConditionalBatch as storageConditionalBatch,
  exportedStorageDeleteRange as storageDeleteRange,
  exportedStorageValuesEqual as storageValuesEqual,
  exportedTextValueStore as textValueStore,
  exportedWeftReservedKeyPrefixes as WEFT_RESERVED_KEY_PREFIXES,
  exportedWithCodec as withCodec,
};
`,
);

// Preserve runtime constructor names for package export-condition smoke tests.
await Bun.build({
  entrypoints: ['./src/storage/bun-sql.ts', './src/storage/node-sqlite.ts'],
  outdir: './dist',
  target: 'bun',
  format: 'esm',
  root: './src',
  naming: '[dir]/[name].js',
  minify: false,
  external: ['bun:sqlite', 'better-sqlite3'],
});

// Browser entrypoints (IndexedDB, web-extension, HTTPStorage).
//
// `service-worker/index.ts` and `server/handler.ts` are deliberately
// EXCLUDED here for the same reason `server/index.ts`/`testing/index.ts`/
// `storage/typed-storage.ts` are excluded from the Bun bundle above: both
// transitively reach `Engine` (and therefore `core/engine/internals.ts`'s
// singleton WeakMap) and neither export is `bun`-condition-gated in
// package.json.
//
// `server/handler.ts` is documented/used as a plain request handler a
// Node/Bun HOST PROCESS can import directly alongside a root-constructed
// `Engine` in the same process (see `runNodeConsumerSmoke` in
// validate-package-consumers.ts).
//
// `service-worker/index.ts` was reconsidered during review: a Service Worker
// DOES run in its own JS realm, separate from the page — but that does NOT
// mean root package imports can never enter that realm. The guide
// (documentation/guides/service-worker.md, "Use the lower-level handlers
// when... you already have an Engine instance you want to reuse (for
// example, a singleton wired up in shared code)") documents exactly the
// pattern where a consumer's OWN Service Worker file imports BOTH
// `@lostgradient/weft` (for `Engine`/`registerSerializer`) AND
// `@lostgradient/weft/service-worker` (for `createFetchHandler` etc.) and
// combines them — all inside that one worker's single realm. If
// `service-worker/index.ts` were bundled separately, its inlined copy of the
// singleton registries would diverge from root's the same way `server/`'s
// did in #710, just inside the worker instead of a Node/Bun process. So it
// stays on the unbundled path with the others.
//
// Both entry points are still browser-bundleable unbundled — the browser
// consumer smoke re-bundles from dist/ with its own `target: 'browser'` pass
// regardless of whether the source dist file was pre-bundled, and a
// consumer's own bundler (Vite/esbuild/Webpack/etc.) does the same for a
// real Service Worker file, per the guide ("The Service Worker has to be a
// separate bundle entry point. Configure your bundler... to emit sw.js").
await Bun.build({
  entrypoints: [
    './src/storage/indexeddb.ts',
    './src/storage/web-extension.ts',
    // HTTPStorage is portable and intentionally emitted from the browser build
    // so the subpath is produced once without a later overwrite.
    './src/storage/http.ts',
  ],
  outdir: './dist',
  target: 'browser',
  format: 'esm',
  naming: '[dir]/[name].js',
  minify: true,
});

await $`bunx tsc --declaration --emitDeclarationOnly --project tsconfig.build.json`;

async function removePackagedArtifactLeaks(): Promise<void> {
  const removeGlobPatterns = [
    'dist/**/*.map',
    'dist/**/*.test-d.d.ts',
    'dist/benchmarks/**',
    'dist/**/__fixtures__/**',
    'dist/**/__tests__/**',
    'dist/workers/test-*',
    'dist/cli/__fixtures__/**',
  ];

  for (const pattern of removeGlobPatterns) {
    const glob = new Bun.Glob(pattern);
    for await (const artifactPath of glob.scan('.')) {
      await $`rm -rf ${artifactPath}`;
    }
  }
}

await removePackagedArtifactLeaks();

// Post-build correctness guards. See scripts/lib/build-guards.ts for what
// each one checks and why — they scan dist/ for a specific class of mistake
// the build can make and fail loudly rather than shipping it.
await assertNoTestOnlyDependenciesInDist();
await assertRelativeImportsResolveInDist();
await assertSingletonModulesNotDuplicated();

// Summarize what shipped so a build prints something actionable instead of a
// bare "complete" — file counts by kind and total dist size make a regression
// (e.g. a suddenly-empty or bloated dist/) visible at a glance.
async function summarizeDist(): Promise<{ js: number; types: number; bytes: number }> {
  let js = 0;
  let types = 0;
  let bytes = 0;
  for await (const distPath of new Bun.Glob('dist/**/*.{js,d.ts}').scan('.')) {
    if (distPath.endsWith('.d.ts')) types += 1;
    else js += 1;
    const stats = await Bun.file(distPath).stat();
    bytes += stats.size;
  }
  return { js, types, bytes };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

const { js, types, bytes } = await summarizeDist();
console.log(
  chalk.green('✓ Build complete') +
    chalk.dim(` — ${js} modules, ${types} type files, ${formatBytes(bytes)} in dist/`),
);

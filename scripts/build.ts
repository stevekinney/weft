import { $ } from 'bun';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import chalk from 'chalk';

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

// Remove block and line comments so a token inside JSDoc/comments (which tsc
// copies into `.d.ts`) is not mistaken for a real import. Build output never
// contains a `//` or `/* */` sequence inside a string literal, so this is
// safe for emitted code even though it would be unsound on arbitrary source.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Reduce a module specifier to its package root (`@scope/name` or `name`). */
function packageRootOf(specifier: string): string {
  if (specifier.startsWith('@')) {
    const [scope, name] = specifier.split('/');
    return name ? `${scope}/${name}` : specifier;
  }
  return specifier.split('/')[0];
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
    const transformed = typescriptTranspiler.transformSync(await Bun.file(sourcePath).text());
    await Bun.write(outputPath, rewriteRelativeJavaScriptSpecifiers(sourcePath, transformed));
  }
}

// Baseline runtime modules. Specialized builds below overwrite the public
// subpaths that need bundling, minification, browser targeting, or constructor
// name preservation.
await writeUnbundledRuntimeModules();

// Node/Bun target — per-backend storage and integration submodules.
// Heavy backends (lmdb, @libsql/client) are externalized so consumers only pay
// for what they actually import.
await Bun.build({
  entrypoints: [
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
    './src/cli-main.ts',
    './src/mcp/cli.ts',
    './src/observability/index.ts',
    './src/json-schema.ts',
    // Bun-only server subpath (@lostgradient/weft/server)
    './src/server/index.ts',
  ],
  outdir: './dist',
  target: 'bun',
  format: 'esm',
  root: './src',
  naming: '[dir]/[name].js',
  minify: true,
  external: ['lmdb', '@libsql/client', '@opentelemetry/api', 'bun:sqlite', 'better-sqlite3'],
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

// Guard: nothing test-only may ship in the published package. Test-support
// helpers under src/ that import dev-only modules used to leak into dist/
// because the build excludes by filename suffix (*.test-support.ts), not by
// reachability — a plainly named helper would compile and ship an import of a
// devDependency a consumer never installs. Renaming the offenders to
// *.test-support.ts fixed it; this assertion keeps it fixed.
//
// We match real module specifiers (import/export-from/require/dynamic-import),
// not raw substrings, and we compare by package root so `bun:test` and any
// subpath like `fake-indexeddb/auto` are both caught. Comments are stripped
// first, because `tsc` emits JSDoc into `.d.ts` files — a shipped doc example
// like `import { JSDOM } from 'jsdom'` is a mention, not a real dependency, and
// must not fail the build. The forbidden set is curated rather than derived
// from every devDependency: several devDependencies (better-sqlite3, valibot)
// are deliberately present in dist/, so a blanket "no devDependency in dist"
// rule would false-positive on them. These packages are test-only or
// build-only modules with no legitimate path into shipped output; add to the
// list if a new test-only or build-only runtime dependency is introduced.
async function assertNoTestOnlyDependenciesInDist(): Promise<void> {
  const forbiddenPackageRoots = [
    'bun:test',
    'bun-plugin-svelte',
    'fake-indexeddb',
    'jsdom',
    'playwright',
    'svelte',
  ];

  // Capture the specifier from every form that pulls in a module: `from '…'`,
  // `require('…')`, dynamic `import('…')`, and bare side-effect `import '…'`
  // (the form the original leak used — `import 'fake-indexeddb/auto'`).
  const specifierPattern =
    /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s+)(["'])([^"']+)\1/g;

  const offenders: { file: string; specifier: string }[] = [];
  const distGlob = new Bun.Glob('dist/**/*.{js,d.ts}');

  for await (const distPath of distGlob.scan('.')) {
    const contents = stripComments(await Bun.file(distPath).text());
    for (const [, , specifier] of contents.matchAll(specifierPattern)) {
      if (forbiddenPackageRoots.includes(packageRootOf(specifier))) {
        offenders.push({ file: distPath, specifier });
      }
    }
  }

  if (offenders.length > 0) {
    console.error('Build produced dist/ artifacts that import test-only dependencies:');
    for (const { file, specifier } of offenders) {
      console.error(`  ${file} imports "${specifier}"`);
    }
    console.error(
      'Rename the offending helper to *.test-support.ts so the build excludes it from dist/.',
    );
    process.exit(1);
  }
}

await assertNoTestOnlyDependenciesInDist();

// Guard: every relative specifier the unbundled runtime build emits must point
// at a file that actually exists in dist/. A bare directory import in source
// (e.g. `export * from './diagnostics'`) used to be rewritten to
// `./diagnostics.js` even though the directory's entry is `diagnostics/index.js`
// — a "Cannot find module" the package consumer only hit at runtime. The
// rewriter now resolves directory imports to `/index.js`; this assertion keeps
// the whole class of dangling relative import out of shipped output.
async function assertRelativeImportsResolveInDist(): Promise<void> {
  // Match every form that pulls in a module: `from '…'`, `require('…')`,
  // dynamic `import('…')`, and bare side-effect `import '…'`.
  const relativeSpecifierPattern =
    /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.\.?\/[^"']+)\1/g;

  const offenders: { file: string; specifier: string }[] = [];
  const distGlob = new Bun.Glob('dist/**/*.js');

  for await (const distPath of distGlob.scan('.')) {
    if (distPath.endsWith('.js.map')) continue;
    const contents = stripComments(await Bun.file(distPath).text());
    for (const [, , specifier] of contents.matchAll(relativeSpecifierPattern)) {
      // Only check JavaScript module specifiers (asset/data files vary).
      if (!specifier.endsWith('.js')) continue;
      const resolved = resolve(dirname(distPath), specifier);
      if (!existsSync(resolved)) {
        offenders.push({ file: distPath, specifier });
      }
    }
  }

  if (offenders.length > 0) {
    console.error('Build produced dist/ artifacts with unresolvable relative imports:');
    for (const { file, specifier } of offenders) {
      console.error(`  ${file} imports "${specifier}" which does not exist`);
    }
    console.error(
      'Write directory re-exports in src/ explicitly as `./dir/index.ts` so the build emits `./dir/index.js`.',
    );
    process.exit(1);
  }
}

await assertRelativeImportsResolveInDist();

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

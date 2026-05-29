import { $ } from 'bun';
import sveltePlugin from 'bun-plugin-svelte';

await $`rm -rf dist`;

const typescriptTranspiler = new Bun.Transpiler({ loader: 'ts', target: 'bun' });

function rewriteRelativeJavaScriptSpecifiers(source: string): string {
  return source
    .replace(/from (["'])(\.\.?\/[^"']+)\1/g, (match, quote: string, specifier: string) => {
      if (/\.(js|json|html|css)$/.test(specifier)) return match;
      const withoutTypeScriptExtension = specifier.endsWith('.ts')
        ? specifier.slice(0, -3)
        : specifier;
      return `from ${quote}${withoutTypeScriptExtension}.js${quote}`;
    })
    .replace(/import\((["'])(\.\.?\/[^"']+)\1\)/g, (match, quote: string, specifier: string) => {
      if (/\.(js|json|html|css)$/.test(specifier)) return match;
      const withoutTypeScriptExtension = specifier.endsWith('.ts')
        ? specifier.slice(0, -3)
        : specifier;
      return `import(${quote}${withoutTypeScriptExtension}.js${quote})`;
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
      sourcePath.includes('/__tests__/') ||
      sourcePath.includes('/__fixtures__/')
    ) {
      continue;
    }

    const outputPath = sourcePath.replace(/^src\//, 'dist/').replace(/\.ts$/, '.js');
    const transformed = typescriptTranspiler.transformSync(await Bun.file(sourcePath).text());
    await Bun.write(outputPath, rewriteRelativeJavaScriptSpecifiers(transformed));
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
// from every devDependency: several devDependencies (better-sqlite3, svelte,
// valibot) are deliberately present in dist/, so a blanket "no devDependency in
// dist" rule would false-positive on them. These three are the test-only
// modules with no legitimate path into shipped output; add to the list if a new
// test-only runtime dependency is introduced.
async function assertNoTestOnlyDependenciesInDist(): Promise<void> {
  const forbiddenPackageRoots = ['bun:test', 'fake-indexeddb', 'jsdom', 'playwright'];

  // Capture the specifier from every form that pulls in a module: `from '…'`,
  // `require('…')`, dynamic `import('…')`, and bare side-effect `import '…'`
  // (the form the original leak used — `import 'fake-indexeddb/auto'`).
  const specifierPattern =
    /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s+)(["'])([^"']+)\1/g;

  // Remove block and line comments so a token inside JSDoc/comments (which tsc
  // copies into `.d.ts`) is not mistaken for a real import. Build output never
  // contains a `//` or `/* */` sequence inside a string literal, so this is
  // safe for emitted code even though it would be unsound on arbitrary source.
  const stripComments = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  const packageRootOf = (specifier: string): string => {
    if (specifier.startsWith('@')) {
      const [scope, name] = specifier.split('/');
      return name ? `${scope}/${name}` : specifier;
    }
    return specifier.split('/')[0];
  };

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

console.log('Build complete!');

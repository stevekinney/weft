#!/usr/bin/env bun
/**
 * Post-build correctness guards for `scripts/build.ts`.
 *
 * Each guard scans the freshly emitted `dist/` tree for a specific class of
 * mistake the build process can make and fails the build (`process.exit(1)`)
 * when it finds one. Kept separate from `scripts/build.ts` itself so the
 * emit logic (what gets written where) stays legible on its own.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Remove block and line comments so a token inside JSDoc/comments (which tsc
// copies into `.d.ts`) is not mistaken for a real import. Build output never
// contains a `//` or `/* */` sequence inside a string literal, so this is
// safe for emitted code even though it would be unsound on arbitrary source.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function allowsForbiddenSpecifier(distPath: string, specifier: string): boolean {
  return specifier === 'bun:test' && distPath === 'dist/storage/testing.js';
}

/** Reduce a module specifier to its package root (`@scope/name` or `name`). */
function packageRootOf(specifier: string): string {
  if (specifier.startsWith('@')) {
    const [scope, name] = specifier.split('/');
    return name ? `${scope}/${name}` : specifier;
  }
  return specifier.split('/')[0] ?? specifier;
}

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
export async function assertNoTestOnlyDependenciesInDist(): Promise<void> {
  const forbiddenPackageRoots = [
    '@electric-sql/pglite',
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
      if (specifier === undefined) continue;
      if (allowsForbiddenSpecifier(distPath, specifier)) continue;
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

// Guard: every relative specifier the unbundled runtime build emits must point
// at a file that actually exists in dist/. A bare directory import in source
// (e.g. `export * from './diagnostics'`) used to be rewritten to
// `./diagnostics.js` even though the directory's entry is `diagnostics/index.js`
// — a "Cannot find module" the package consumer only hit at runtime. The
// rewriter now resolves directory imports to `/index.js`; this assertion keeps
// the whole class of dangling relative import out of shipped output.
export async function assertRelativeImportsResolveInDist(): Promise<void> {
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
      if (specifier === undefined) continue;
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

// Guard: a module-scope singleton registry must resolve to exactly one
// on-disk module across every public entry point. Bundling an entry point
// that transitively imports a singleton-bearing module (e.g. `Engine`, which
// pulls in `core/engine/internals.ts`'s WeakMap) inlines a private copy of
// that module's state — so an `Engine` built via the unbundled root import
// registers its internals in ROOT's WeakMap, while a bundled `serve()`
// checks its OWN, separately-inlined WeakMap, which never saw it. That was
// #710: `serve({ engine })` unconditionally threw "Engine internals not
// initialized" for every consumer of the published package.
//
// Each singleton module's throw-string literal survives minification (string
// literals aren't renamed), so we can fingerprint it and assert it appears in
// dist/ exactly once — in the singleton module's own unbundled output file.
// A second occurrence means some other entry point re-inlined it and must be
// moved off the bundled path (see the comment above the storage/CLI/server
// Bun.build() call in scripts/build.ts). Add an entry here whenever a new
// module-scope WeakMap/Map/Set registry is introduced that more than one
// public entry point can reach.
export const SINGLETON_MODULE_MARKERS: { canonicalFile: string; marker: string }[] = [
  {
    canonicalFile: 'dist/core/engine/internals.js',
    marker: 'was not called in the Engine constructor',
  },
  {
    canonicalFile: 'dist/core/codec/serializer-registry.js',
    marker: 'No serializer registered for tag',
  },
  {
    canonicalFile: 'dist/core/context/internals.js',
    marker: 'Context internals not initialized',
  },
];

/**
 * dist/ files that are ALLOWED to duplicate a singleton marker, each with an
 * explicit reason. Add an entry here only when the duplicate genuinely cannot
 * cause the #710 bug class — i.e. no live object or process-wide registry
 * from a root-constructed `Engine` can ever cross into this file's execution
 * context, regardless of bundling. This is deliberately empty: every current
 * public entry point either stays unbundled (sharing state with root) or is
 * bin-only with no importable export AND unbundled itself (`cli-main.ts`/
 * `mcp/cli.ts` — see the comment above their entrypoints list in
 * scripts/build.ts for why even those two stay off the bundled path). Before
 * adding an entry here, confirm the file cannot end up in the same process
 * as root-registered singleton state via ANY path, including a dynamically
 * `import()`ed module the file itself loads at runtime — that's exactly how
 * an earlier version of this allowlist (for the CLI bins) turned out to be
 * unsound.
 */
const KNOWN_SAFE_DUPLICATE_FILES: { readonly file: string; readonly reason: string }[] = [];

export async function assertSingletonModulesNotDuplicated(): Promise<void> {
  const knownSafeDuplicateFiles = new Set(KNOWN_SAFE_DUPLICATE_FILES.map((entry) => entry.file));
  const canonicalFilesFound = new Set<string>();
  const offenders: { file: string; marker: string; canonicalFile: string }[] = [];
  const distGlob = new Bun.Glob('dist/**/*.js');

  // Single pass over dist/: read each file once and check it against every
  // marker, rather than re-scanning the whole tree once per marker.
  for await (const distPath of distGlob.scan('.')) {
    if (distPath.endsWith('.js.map')) continue;
    const contents = await Bun.file(distPath).text();
    for (const { canonicalFile, marker } of SINGLETON_MODULE_MARKERS) {
      if (!contents.includes(marker)) continue;
      if (distPath === canonicalFile) {
        canonicalFilesFound.add(canonicalFile);
        continue;
      }
      if (knownSafeDuplicateFiles.has(distPath)) continue;
      offenders.push({ file: distPath, marker, canonicalFile });
    }
  }

  // A marker missing from its own canonical file means the throw message was
  // reworded, or the module was renamed/moved, without updating this guard —
  // silently passing here would disable the protection entirely, since an
  // actual duplicate elsewhere would never be compared against anything.
  const missingCanonicalMarkers = SINGLETON_MODULE_MARKERS.filter(
    ({ canonicalFile }) => !canonicalFilesFound.has(canonicalFile),
  );

  if (missingCanonicalMarkers.length > 0) {
    console.error('Build did not find a singleton marker string in its own canonical dist/ file:');
    for (const { canonicalFile, marker } of missingCanonicalMarkers) {
      console.error(`  expected "${marker}" in ${canonicalFile}, but it was not found there`);
    }
    console.error(
      'Update SINGLETON_MODULE_MARKERS in scripts/lib/build-guards.ts to match the current ' +
        'canonical file path and throw message.',
    );
    process.exit(1);
  }

  if (offenders.length > 0) {
    console.error(
      'Build produced dist/ artifacts that duplicate a module-scope singleton registry:',
    );
    for (const { file, marker, canonicalFile } of offenders) {
      console.error(`  ${file} inlines "${marker}" — expected only in ${canonicalFile}`);
    }
    console.error(
      'Remove the offending entry point from the bundled Bun.build() call in scripts/build.ts ' +
        'so it stays on the unbundled path and shares the singleton module with root, or add ' +
        'it to KNOWN_SAFE_DUPLICATE_FILES with a reason if it genuinely cannot share state.',
    );
    process.exit(1);
  }
}

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
      sourcePath.startsWith('src/embedded/backchannel/scripts/') ||
      sourcePath === 'src/embedded/backchannel/src/generator.ts' ||
      sourcePath === 'src/embedded/backchannel/src/testing.ts' ||
      sourcePath.startsWith('src/embedded/storage/src/testing/') ||
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

// Emit one module tree so all public entries and the CLI share the same engine,
// serializer, and storage module instances in an installed consumer.
await writeUnbundledRuntimeModules();

await $`bunx tsc --declaration --emitDeclarationOnly --project tsconfig.build.json`;

async function removePackagedArtifactLeaks(): Promise<void> {
  const removeGlobPatterns = [
    'dist/**/*.map',
    'dist/**/*.test-d.d.ts',
    'dist/**/*.test-support.d.ts',
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

/**
 * Verifies that per-backend submodule exports are correctly tree-shakable.
 *
 * Builds tiny consumer entries against the local dist/ and asserts that:
 *  - Importing from dist/storage/memory does NOT pull in lmdb or @libsql/client
 *  - Importing from dist/storage/lmdb keeps lmdb as an external import (not inlined)
 *
 * Run after `bun run build`: bun run verify:exports
 */

import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const repositoryPath = join(import.meta.dir, '..');
const distPath = join(repositoryPath, 'dist');
const packageName = '@lostgradient/weft';

// ---------------------------------------------------------------------------
// Helper: build a tiny entry file importing from a dist path and return text
// ---------------------------------------------------------------------------
async function buildEntry(
  distRelativePath: string,
  namedExport: string,
  external: string[] = [],
): Promise<string> {
  const tempDir = mkdtempSync(join(tmpdir(), 'weft-treeshake-'));
  const entryFile = join(tempDir, 'entry.ts');
  const absoluteTarget = join(distPath, distRelativePath);

  try {
    // Use the absolute POSIX path as the import specifier. Bun.build does not
    // accept file:// URLs — and since this script only runs on Bun (macOS/Linux),
    // backslash path separators are not a concern.
    await Bun.write(
      entryFile,
      `import { ${namedExport} } from ${JSON.stringify(absoluteTarget)}; export { ${namedExport} };`,
    );

    const result = await Bun.build({
      entrypoints: [entryFile],
      outdir: join(tempDir, 'out'),
      target: 'bun',
      format: 'esm',
      minify: true,
      packages: 'bundle',
      external,
    });

    if (!result.success) {
      const messages = result.logs.map((l) => l.message).join('\n');
      throw new Error(`Build failed:\n${messages}`);
    }

    const outputs = await Promise.all(result.outputs.map((o) => o.text()));
    return outputs.join('\n');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

let failed = false;

function pass(message: string): void {
  process.stdout.write(`✓ ${message}\n`);
}

function fail(message: string): void {
  process.stderr.write(`✗ ${message}\n`);
  failed = true;
}

function runSmokeScript(
  command: readonly string[],
  runtimeName: string,
  description: string,
  script: string,
): void {
  const result = Bun.spawnSync([...command, script], {
    cwd: repositoryPath,
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  });

  if (result.exitCode === 0) {
    pass(`${description} under ${runtimeName}`);
    return;
  }

  const stderr = new TextDecoder().decode(result.stderr).trim();
  const stdout = new TextDecoder().decode(result.stdout).trim();
  fail(
    [
      `${description} failed under ${runtimeName}`,
      stdout ? `stdout:\n${stdout}` : '',
      stderr ? `stderr:\n${stderr}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

function runSQLiteImportSmokeTest(
  command: readonly string[],
  expectedConstructorName: string,
  runtimeName: string,
): void {
  const script = [
    "import { SQLiteStorage } from '@lostgradient/weft/storage/sqlite';",
    `if (SQLiteStorage.name !== ${JSON.stringify(expectedConstructorName)}) {`,
    `  throw new Error(\`Expected ${runtimeName} to resolve SQLiteStorage to ${expectedConstructorName}, got \${SQLiteStorage.name}\`);`,
    '}',
  ].join('\n');
  runSmokeScript(
    command,
    runtimeName,
    `@lostgradient/weft/storage/sqlite resolves to ${expectedConstructorName}`,
    script,
  );
}

function resolveRealNodeExecutable(): string | null {
  const bunExecutable = realpathSync(process.execPath);
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory.includes('bun-node-')) continue;

    const candidate = join(directory, 'node');
    if (!existsSync(candidate)) continue;

    const realCandidate = realpathSync(candidate);
    if (realCandidate === bunExecutable || realCandidate.includes('/.bun/')) continue;

    return candidate;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Test 1: storage/memory must NOT contain heavy backend code
// ---------------------------------------------------------------------------
const memoryBundle = await buildEntry('storage/memory.js', 'MemoryStorage', [
  'lmdb',
  '@libsql/client',
  'bun:sqlite',
]);

const heavyTokens = ['LMDBStorage', 'TursoStorage', 'BunSQLiteStorage'];
const foundHeavy = heavyTokens.filter((token) => memoryBundle.includes(token));

if (foundHeavy.length > 0) {
  fail(
    `@lostgradient/weft/storage/memory bundle contains heavy backend code: ${foundHeavy.join(', ')}`,
  );
} else {
  pass('@lostgradient/weft/storage/memory is free of heavy backend code');
}

// ---------------------------------------------------------------------------
// Test 2: storage/index (barrel) must NOT pull in heavy backends
// ---------------------------------------------------------------------------
const storageBarrelBundle = await buildEntry('storage/index.js', 'MemoryStorage', [
  'lmdb',
  '@libsql/client',
  'bun:sqlite',
]);

const foundInBarrel = heavyTokens.filter((token) => storageBarrelBundle.includes(token));

if (foundInBarrel.length > 0) {
  fail(
    `@lostgradient/weft/storage barrel bundle contains heavy backend code: ${foundInBarrel.join(', ')}`,
  );
} else {
  pass('@lostgradient/weft/storage barrel is free of heavy backend code');
}

// ---------------------------------------------------------------------------
// Test 3: storage/lmdb keeps lmdb as an external (not inlined)
// ---------------------------------------------------------------------------
const lmdbBundle = await buildEntry('storage/lmdb.js', 'LMDBStorage', [
  'lmdb',
  '@libsql/client',
  'bun:sqlite',
]);

if (!lmdbBundle.includes('lmdb')) {
  fail(
    '@lostgradient/weft/storage/lmdb bundle has no reference to lmdb (should be external import)',
  );
} else if (lmdbBundle.includes('@libsql/client')) {
  fail('@lostgradient/weft/storage/lmdb bundle unexpectedly contains @libsql/client');
} else {
  pass('@lostgradient/weft/storage/lmdb externalizes lmdb correctly');
}

// ---------------------------------------------------------------------------
// Test 4: storage/turso keeps @libsql/client as an external
// ---------------------------------------------------------------------------
const tursoBundle = await buildEntry('storage/turso.js', 'TursoStorage', [
  'lmdb',
  '@libsql/client',
  'bun:sqlite',
]);

if (!tursoBundle.includes('@libsql/client')) {
  fail(
    '@lostgradient/weft/storage/turso bundle has no reference to @libsql/client (should be external import)',
  );
} else {
  pass('@lostgradient/weft/storage/turso externalizes @libsql/client correctly');
}

// Test 5: root entrypoint must not export testing primitives
// ---------------------------------------------------------------------------
{
  const tempDir = mkdtempSync(join(tmpdir(), 'weft-root-testing-export-'));
  const entryFile = join(tempDir, 'entry.ts');
  const fixtureFile = join(import.meta.dir, 'fixtures/root-import-testing.ts');
  const rootEntrypoint = join(distPath, 'index.js');

  try {
    const fixtureSource = await Bun.file(fixtureFile).text();
    const packageSpecifier = `'${packageName}'`;
    const patchedSource = fixtureSource.replace(packageSpecifier, JSON.stringify(rootEntrypoint));
    if (patchedSource === fixtureSource) {
      throw new Error(
        `Test 5: fixture replacement produced no change. ${fixtureFile} no longer contains the literal ${packageSpecifier} — update the fixture or the replacement target.`,
      );
    }
    await Bun.write(entryFile, patchedSource);

    try {
      const result = await Bun.build({
        entrypoints: [entryFile],
        outdir: join(tempDir, 'out'),
        target: 'bun',
        format: 'esm',
        minify: true,
        packages: 'bundle',
        throw: false,
      });
      const messages = result.logs.map((log) => log.message).join('\n');

      if (result.success) {
        fail('weft root entrypoint still exports TestEngine');
      } else if (!/TestEngine|no matching export/i.test(messages)) {
        fail(`weft root TestEngine import failed with an unexpected message:\n${messages}`);
      } else {
        pass('weft root entrypoint rejects TestEngine imports');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/TestEngine|no matching export/i.test(message)) {
        fail(`weft root TestEngine import threw an unexpected error:\n${message}`);
      } else {
        pass('weft root entrypoint rejects TestEngine imports');
      }
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Test 6: root bundle must not contain testing source files or identifiers
// ---------------------------------------------------------------------------
const rootBundle = await buildEntry('index.js', 'Engine', ['lmdb', '@libsql/client', 'bun:sqlite']);

const testingSourceTokens = [
  'src/testing/test-engine',
  'src/testing/time-control',
  'src/testing/mocks',
  'src/testing/chaos',
];
const testingIdentifierTokens = [
  'TestEngine',
  'TimeControl',
  'ActivityMockRegistry',
  'ChaosTransientError',
  'ChaosTimeoutError',
  'ChaosNonRetryableError',
  'withChaos',
];
const foundTestingBundleTokens = [...testingSourceTokens, ...testingIdentifierTokens].filter(
  (token) => rootBundle.includes(token),
);

if (foundTestingBundleTokens.length > 0) {
  fail(`weft root bundle contains testing code: ${foundTestingBundleTokens.join(', ')}`);
} else {
  pass('weft root bundle excludes testing source files and identifiers');
}

// ---------------------------------------------------------------------------
// Test 7: testing subpath exports testing primitives
// ---------------------------------------------------------------------------
{
  const tempDir = mkdtempSync(join(tmpdir(), 'weft-testing-subpath-'));
  const entryFile = join(tempDir, 'entry.ts');
  const testingEntrypoint = join(distPath, 'testing/index.js');

  try {
    await Bun.write(
      entryFile,
      [
        `import { ActivityMockRegistry, TestEngine, TimeControl, withChaos } from ${JSON.stringify(testingEntrypoint)};`,
        'export { ActivityMockRegistry, TestEngine, TimeControl, withChaos };',
      ].join('\n'),
    );

    const result = await Bun.build({
      entrypoints: [entryFile],
      outdir: join(tempDir, 'out'),
      target: 'bun',
      format: 'esm',
      minify: true,
      packages: 'bundle',
      external: ['lmdb', '@libsql/client', 'bun:sqlite'],
    });

    if (!result.success) {
      const messages = result.logs.map((log) => log.message).join('\n');
      fail(`@lostgradient/weft/testing failed to export testing primitives:\n${messages}`);
    } else {
      const outputs = await Promise.all(result.outputs.map((output) => output.text()));
      const bundleText = outputs.join('\n');
      const requiredIdentifiers = [
        'ActivityMockRegistry',
        'TestEngine',
        'TimeControl',
        'withChaos',
      ];
      const missing = requiredIdentifiers.filter((token) => !bundleText.includes(token));
      if (missing.length > 0) {
        fail(
          `@lostgradient/weft/testing bundle is missing expected exports: ${missing.join(', ')}`,
        );
      } else {
        pass('@lostgradient/weft/testing exports testing primitives');
      }
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Test 8: @lostgradient/weft/storage and @lostgradient/weft/testing barrels load cleanly and expose
// their value exports.
//
// The Bun 1.3.13 minifier emits broken JavaScript for pure re-export barrels,
// where Node's loader rejects the dist file with `Export 'B' is not defined
// in module`. The aliased-const-export workaround in src/storage/index.ts
// and src/testing/index.ts fixes that. This test guards against regression:
// load each dist barrel in-process and confirm every documented value
// export resolves. Without these, a future refactor that flattens either
// barrel back to direct re-exports would silently break the package.
// ---------------------------------------------------------------------------
{
  const cases: Array<{ entrypoint: string; label: string; expectedExports: string[] }> = [
    {
      entrypoint: join(distPath, 'storage/index.js'),
      label: '@lostgradient/weft/storage',
      expectedExports: [
        'KEYS',
        'MemoryStorage',
        'resolveStorage',
        'ScopedStorage',
        'jsonCodec',
        'msgpackCodec',
        'scopedStorage',
        'storageConditionalBatch',
        'storageValuesEqual',
        'withCodec',
      ],
    },
    {
      entrypoint: join(distPath, 'testing/index.js'),
      label: '@lostgradient/weft/testing',
      expectedExports: [
        'ActivityMockRegistry',
        'ChaosNonRetryableError',
        'ChaosTimeoutError',
        'ChaosTransientError',
        'TestEngine',
        'TimeControl',
        'withChaos',
      ],
    },
  ];

  for (const { entrypoint, label, expectedExports } of cases) {
    try {
      if (label === '@lostgradient/weft/storage') {
        const barrelText = readFileSync(entrypoint, 'utf8');
        if (/export\s*\{[^}]+\}\s*from\s*['"]\.\//.test(barrelText)) {
          fail('@lostgradient/weft/storage barrel must keep the local-binding export workaround');
        }
      }

      const module = (await import(entrypoint)) as Record<string, unknown>;
      const missing = expectedExports.filter((name) => module[name] === undefined);
      if (missing.length > 0) {
        fail(`${label} barrel is missing exports: ${missing.join(', ')}`);
      } else {
        pass(`${label} barrel loads cleanly with all value exports`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fail(`${label} barrel failed to load: ${message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Test 9: storage package entrypoints load in their intended runtimes
// ---------------------------------------------------------------------------
const storageBarrelScript = [
  "import * as storage from '@lostgradient/weft/storage';",
  "for (const name of ['KEYS', 'MemoryStorage', 'resolveStorage', 'ScopedStorage', 'scopedStorage', 'withCodec', 'jsonCodec', 'msgpackCodec']) {",
  '  if (!(name in storage)) throw new Error(`Missing storage barrel export: ${name}`);',
  '}',
].join('\n');

const storageAdapterSubpathsScript = [
  "import { HTTPStorage } from '@lostgradient/weft/storage/http';",
  "import { resolveStorage } from '@lostgradient/weft/storage/resolve';",
  "import { resolveDefaultStorage } from '@lostgradient/weft/storage/auto';",
  "import { WebExtensionStorage } from '@lostgradient/weft/storage/web-extension';",
  "if (typeof HTTPStorage !== 'function') throw new Error('HTTPStorage subpath failed');",
  "if (typeof WebExtensionStorage !== 'function') throw new Error('WebExtensionStorage subpath failed');",
  "if (typeof resolveDefaultStorage !== 'function') throw new Error('resolveDefaultStorage subpath failed');",
  "if (typeof resolveStorage !== 'function') throw new Error('resolveStorage subpath failed');",
].join('\n');

const bunSqliteOverrideScript = [
  "import { BunSQLiteStorage, SQLiteStorage } from '@lostgradient/weft/storage/sqlite/bun';",
  "if (BunSQLiteStorage.name !== 'BunSQLiteStorage') throw new Error('BunSQLiteStorage export failed');",
  "if (SQLiteStorage.name !== 'BunSQLiteStorage') throw new Error('SQLiteStorage Bun override failed');",
].join('\n');

const nodeSqliteOverrideScript = [
  "import { NodeSQLiteStorage, SQLiteStorage } from '@lostgradient/weft/storage/sqlite/node';",
  "if (NodeSQLiteStorage.name !== 'NodeSQLiteStorage') throw new Error('NodeSQLiteStorage export failed');",
  "if (SQLiteStorage.name !== 'NodeSQLiteStorage') throw new Error('SQLiteStorage Node override failed');",
].join('\n');

runSmokeScript(
  [process.execPath, '--eval'],
  'Bun',
  '@lostgradient/weft/storage full barrel imports',
  storageBarrelScript,
);
runSmokeScript(
  [process.execPath, '--eval'],
  'Bun',
  'new storage adapter subpaths import',
  storageAdapterSubpathsScript,
);
runSmokeScript(
  [process.execPath, '--eval'],
  'Bun',
  '@lostgradient/weft/storage/sqlite/bun explicit override imports',
  bunSqliteOverrideScript,
);
runSQLiteImportSmokeTest([process.execPath, '--eval'], 'BunSQLiteStorage', 'Bun');

const nodeExecutable = resolveRealNodeExecutable();
if (nodeExecutable === null) {
  fail(
    '@lostgradient/weft/storage/sqlite Node.js import smoke test requires a real node executable on PATH',
  );
} else {
  runSmokeScript(
    [nodeExecutable, '--input-type=module', '--eval'],
    'Node.js',
    '@lostgradient/weft/storage full barrel imports',
    storageBarrelScript,
  );
  runSmokeScript(
    [nodeExecutable, '--input-type=module', '--eval'],
    'Node.js',
    'new storage adapter subpaths import',
    storageAdapterSubpathsScript,
  );
  runSmokeScript(
    [nodeExecutable, '--input-type=module', '--eval'],
    'Node.js',
    '@lostgradient/weft/storage/sqlite/node explicit override imports',
    nodeSqliteOverrideScript,
  );
  runSQLiteImportSmokeTest(
    [nodeExecutable, '--input-type=module', '--eval'],
    'NodeSQLiteStorage',
    'Node.js',
  );
}

// ---------------------------------------------------------------------------
// Test 10: @lostgradient/weft/service-worker bundle must not pull in Bun/Node SQLite adapters
//
// `resolveDefaultStorage` is exported only from `@lostgradient/weft/storage/auto`, which the
// service-worker entrypoint must never import (directly or transitively).
// Verify the emitted bundle is free of any Bun/Node-only storage code so
// browser consumers don't ship dead SQLite chunks.
// ---------------------------------------------------------------------------
const serviceWorkerBundle = readFileSync(join(distPath, 'service-worker/index.js'), 'utf-8');
const serviceWorkerForbiddenTokens = [
  'BunSQLiteStorage',
  'NodeSQLiteStorage',
  'bun:sqlite',
  'better-sqlite3',
  'src/storage/auto',
];
const foundInServiceWorker = serviceWorkerForbiddenTokens.filter((token) =>
  serviceWorkerBundle.includes(token),
);

if (foundInServiceWorker.length > 0) {
  fail(
    `@lostgradient/weft/service-worker bundle contains forbidden SQLite adapter code: ${foundInServiceWorker.join(', ')}`,
  );
} else {
  pass('@lostgradient/weft/service-worker bundle is free of SQLite adapter code');
}

if (failed) {
  process.exit(1);
}

process.stdout.write('\nAll tree-shaking checks passed.\n');

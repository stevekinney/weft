import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const repositoryPath = join(import.meta.dir, '..');
const packageName = '@lostgradient/weft';
const textDecoder = new TextDecoder();

type PackResult = {
  filename: string;
};

function commandOutput(output: Uint8Array): string {
  return textDecoder.decode(output).trim();
}

function createSubprocessEnvironment(
  overrides: Record<string, string> = {},
): Record<string, string> {
  const environment = { ...process.env, ...overrides };
  delete environment.npm_config_dry_run;
  delete environment.npm_config_dry_run_;
  return environment;
}

function runCommand(label: string, command: string[], cwd: string): void {
  const result = Bun.spawnSync(command, {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: createSubprocessEnvironment(),
  });

  if (result.exitCode === 0) {
    console.log(`✓ ${label}`);
    return;
  }

  const stdout = commandOutput(result.stdout);
  const stderr = commandOutput(result.stderr);
  throw new Error(
    [
      `${label} failed with exit ${result.exitCode}`,
      `command: ${command.join(' ')}`,
      stdout ? `stdout:\n${stdout}` : '',
      stderr ? `stderr:\n${stderr}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

function resolveRealNodeExecutable(): string {
  const bunExecutable = realpathSync(process.execPath);
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory.includes('bun-node-')) continue;
    const candidate = join(directory, 'node');
    try {
      const realCandidate = realpathSync(candidate);
      if (realCandidate !== bunExecutable && !realCandidate.includes('/.bun/')) {
        return candidate;
      }
    } catch {
      // Keep looking.
    }
  }
  throw new Error('validate-package-consumers requires a real node executable on PATH');
}

function packPackage(packDirectory: string): string {
  const result = Bun.spawnSync(
    ['npm', 'pack', '--json', '--ignore-scripts', '--pack-destination', packDirectory],
    {
      cwd: repositoryPath,
      stdout: 'pipe',
      stderr: 'pipe',
      env: createSubprocessEnvironment({ npm_config_loglevel: 'silent' }),
    },
  );
  const stdout = commandOutput(result.stdout);
  const stderr = commandOutput(result.stderr);

  if (result.exitCode !== 0) {
    throw new Error(`npm pack failed with exit ${result.exitCode}\n${stderr}\n${stdout}`.trim());
  }

  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error(`npm pack returned an unexpected shape: ${stdout}`);
  }
  const packResult = parsed[0] as PackResult;
  const tarballPath = join(packDirectory, packResult.filename);
  if (!existsSync(tarballPath)) {
    throw new Error(`npm pack reported ${tarballPath}, but the tarball was not created`);
  }
  return tarballPath;
}

async function createConsumerProject(
  consumerDirectory: string,
  tarballPath: string,
): Promise<void> {
  mkdirSync(consumerDirectory, { recursive: true });
  await Bun.write(
    join(consumerDirectory, 'package.json'),
    `${JSON.stringify(
      {
        private: true,
        type: 'module',
        dependencies: {
          [packageName]: `file:${tarballPath}`,
        },
        devDependencies: {
          '@types/bun': '1.3.13',
          typescript: '5.9.3',
        },
      },
      null,
      2,
    )}\n`,
  );
  runCommand(
    'install packed package with npm in consumer fixture',
    ['npm', 'install', '--ignore-scripts'],
    consumerDirectory,
  );
}

async function runBunConsumerSmoke(consumerDirectory: string): Promise<void> {
  const script = [
    `import { Engine, LocalClient, MemoryStorage, workflow } from '${packageName}';`,
    `import { TestEngine } from '${packageName}/testing';`,
    `import * as storage from '${packageName}/storage';`,
    `import { SQLiteStorage } from '${packageName}/storage/sqlite';`,
    `import { createFetchHandler } from '${packageName}/service-worker';`,
    `import { parseWorkerToServerMessage } from '${packageName}/worker-protocol';`,
    `import { createMcpSessionManager } from '${packageName}/mcp';`,
    `import { createObservabilityInterceptors } from '${packageName}/observability';`,
    `import { validateStandardSchema } from '${packageName}/json-schema';`,
    'for (const value of [Engine, MemoryStorage, workflow, LocalClient, TestEngine, storage.MemoryStorage, SQLiteStorage, createFetchHandler, parseWorkerToServerMessage, createMcpSessionManager, createObservabilityInterceptors, validateStandardSchema]) {',
    "  if (value === undefined) throw new Error('missing Bun consumer export');",
    '}',
    "if (SQLiteStorage.name !== 'BunSQLiteStorage') throw new Error(`expected Bun SQLite export, got ${SQLiteStorage.name}`);",
  ].join('\n');
  runCommand(
    'Bun consumer imports public package surface',
    [process.execPath, '--eval', script],
    consumerDirectory,
  );
}

async function runNodeConsumerSmoke(consumerDirectory: string): Promise<void> {
  const nodeExecutable = resolveRealNodeExecutable();
  const script = [
    `import { Engine, MemoryStorage } from '${packageName}';`,
    `import { HttpClient } from '${packageName}/client';`,
    `import { MemoryStorage as SubpathMemoryStorage } from '${packageName}/storage/memory';`,
    `import { SQLiteStorage } from '${packageName}/storage/sqlite';`,
    `import { handleRequest } from '${packageName}/server/handler';`,
    `import { parseWorkerToServerMessage } from '${packageName}/worker-protocol';`,
    'for (const value of [Engine, MemoryStorage, HttpClient, SubpathMemoryStorage, SQLiteStorage, handleRequest, parseWorkerToServerMessage]) {',
    "  if (value === undefined) throw new Error('missing Node consumer export');",
    '}',
    "if (SQLiteStorage.name !== 'NodeSQLiteStorage') throw new Error(`expected Node SQLite export, got ${SQLiteStorage.name}`);",
  ].join('\n');
  runCommand(
    'Node.js consumer imports portable public package surface',
    [nodeExecutable, '--input-type=module', '--eval', script],
    consumerDirectory,
  );
}

async function runBrowserBundleSmoke(consumerDirectory: string): Promise<void> {
  const entrypoint = join(consumerDirectory, 'browser-entry.ts');
  const outdir = join(consumerDirectory, 'browser-out');
  await Bun.write(
    entrypoint,
    [
      `import { HttpClient } from '${packageName}/client';`,
      `import { createFetchHandler } from '${packageName}/service-worker';`,
      `import { IndexedDBStorage } from '${packageName}/storage/indexeddb';`,
      `import { HTTPStorage } from '${packageName}/storage/http';`,
      `import { handleRequest } from '${packageName}/server/handler';`,
      'export { HttpClient, createFetchHandler, IndexedDBStorage, HTTPStorage, handleRequest };',
    ].join('\n'),
  );

  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir,
    target: 'browser',
    format: 'esm',
    minify: true,
  });

  if (!result.success) {
    throw new Error(
      `browser consumer bundle failed:\n${result.logs.map((log) => log.message).join('\n')}`,
    );
  }

  const bundleOutputs = await Promise.all(result.outputs.map((output) => output.text()));
  const bundleText = bundleOutputs.join('\n');
  const staticRuntimeImportPattern =
    /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(?:bun:|node:)[^"']+\1/g;
  const staticRuntimeImports = [...bundleText.matchAll(staticRuntimeImportPattern)].map(
    (match) => match[0],
  );
  if (staticRuntimeImports.length > 0) {
    throw new Error(
      `browser consumer bundle statically imports Bun/Node modules: ${staticRuntimeImports.join(', ')}`,
    );
  }

  const forbiddenTokens = ['BunSQLiteStorage', 'NodeSQLiteStorage', 'better-sqlite3'];
  const found = forbiddenTokens.filter((token) => bundleText.includes(token));
  if (found.length > 0) {
    throw new Error(
      `browser consumer bundle contains server-only storage tokens: ${found.join(', ')}`,
    );
  }

  console.log('✓ browser consumer bundle excludes Bun/Node-only storage code');
}

async function runTypeScriptConsumerSmoke(consumerDirectory: string): Promise<void> {
  await Bun.write(
    join(consumerDirectory, 'consumer.ts'),
    [
      `import type { Engine } from '${packageName}';`,
      `import type { WeftClient } from '${packageName}/client';`,
      `declare module '${packageName}' {`,
      '  interface WorkflowRegistry {',
      '    welcome: { input: { name: string }; output: { greeting: string } };',
      '  }',
      '}',
      'declare const engine: Engine;',
      'declare const client: WeftClient;',
      'async function checkEngine(): Promise<void> {',
      "  const handle = await engine.start('welcome', { name: 'Steve' });",
      '  const output = await handle.result();',
      '  output.greeting.toUpperCase();',
      '}',
      'async function checkClient(): Promise<void> {',
      "  const handle = await client.start('welcome', { name: 'Steve' });",
      '  const output = await handle.result();',
      '  output.greeting.toUpperCase();',
      '}',
      'void checkEngine;',
      'void checkClient;',
    ].join('\n'),
  );
  await Bun.write(
    join(consumerDirectory, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'bundler',
          strict: true,
          skipLibCheck: true,
          noEmit: true,
        },
        include: ['consumer.ts'],
      },
      null,
      2,
    )}\n`,
  );

  runCommand(
    'TypeScript consumer compiles scoped module augmentation',
    [join(consumerDirectory, 'node_modules/.bin/tsc'), '--noEmit', '-p', 'tsconfig.json'],
    consumerDirectory,
  );
}

async function main(): Promise<void> {
  const workingDirectory = mkdtempSync(join(tmpdir(), 'weft-package-consumers-'));
  try {
    const tarballPath = packPackage(workingDirectory);
    const consumerDirectory = join(workingDirectory, 'consumer');
    await createConsumerProject(consumerDirectory, tarballPath);
    await runBunConsumerSmoke(consumerDirectory);
    await runNodeConsumerSmoke(consumerDirectory);
    await runBrowserBundleSmoke(consumerDirectory);
    await runTypeScriptConsumerSmoke(consumerDirectory);
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
}

await main();

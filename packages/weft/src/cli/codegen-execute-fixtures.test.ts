import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import ts from 'typescript';

import manifest from '../../package.json';

import { codegenPackageName, executeCodegen } from './codegen.ts';

const FIXTURE_DIR = resolve(import.meta.dir, '__fixtures__/codegen');
const PACKAGE_ROOT = resolve(import.meta.dir, '../..');
const REPOSITORY_ROOT = resolve(PACKAGE_ROOT, '../..');
const REGISTRY_FIXTURE = join(FIXTURE_DIR, 'registry.json');
const EXPECTED_DTS = join(FIXTURE_DIR, 'expected.d.txt');
const TYPECHECK_GENERATED_DTS = join(FIXTURE_DIR, 'typecheck', 'weft.generated.d.ts');
const PACKED_FIXTURE_VERSION = '0.0.0-packed-fixture';

/**
 * Arguments for the packed consumer's `bun install`.
 *
 * The consumer has no lockfile, so Bun resolves the packed tarball's dependency
 * ranges against registry manifests. Never pass `--prefer-offline` (or
 * `--offline`) here: either makes Bun trust whatever manifest sits in the
 * machine's global install cache without revalidating it, so a manifest cached
 * before a dependency published a newer version cannot satisfy a range that
 * needs it. That is how `ts-morph@28.0.0`'s `@ts-morph/common@~0.29.0` failed
 * with "No version matching" on hosts whose cached manifest predated 0.29.0,
 * even though the version existed on the registry. Tarballs still come from
 * the cache; only the manifests are revalidated.
 */
const PACKED_CONSUMER_INSTALL_ARGUMENTS = [
  'install',
  '--production',
  '--ignore-scripts',
  '--no-progress',
  '--no-summary',
] as const;

/**
 * The one token in the golden that is not literal output.
 *
 * `weft codegen` augments whatever this package is published as, so the golden
 * cannot hold a package name and still be right in more than one repository:
 * the mirror transform rewrites module specifiers in files it can parse, and
 * `.d.txt` is not one of them, so a literal name here would keep naming this
 * workspace downstream while the emitter named the published package. Every
 * other byte of the golden is compared exactly; only this token is filled in.
 */
const PACKAGE_NAME_PLACEHOLDER = '@@PACKAGE_NAME@@';

async function readGolden(): Promise<string> {
  const template = await Bun.file(EXPECTED_DTS).text();
  if (!template.includes(PACKAGE_NAME_PLACEHOLDER)) {
    throw new Error(
      `${EXPECTED_DTS} no longer carries ${PACKAGE_NAME_PLACEHOLDER}; a golden with a literal package name silently stops checking the emitted module name`,
    );
  }
  return template.replaceAll(PACKAGE_NAME_PLACEHOLDER, codegenPackageName);
}

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weft-codegen-'));
  tempDirs.push(dir);
  return dir;
}

const persistentTempDirs: string[] = [];
function makePersistentTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weft-codegen-'));
  persistentTempDirs.push(dir);
  return dir;
}

type ProcessResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

async function runProcess(command: readonly string[], cwd: string): Promise<ProcessResult> {
  const process = Bun.spawn({
    cmd: [...command],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...Bun.env },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

function copyDirectory(source: string, destination: string): void {
  cpSync(source, destination, {
    recursive: true,
    filter: (path) => {
      const parts = path.split(/[\\/]/);
      return !parts.some((part) =>
        ['node_modules', 'coverage', '.turbo', '.git', 'test-results'].includes(part),
      );
    },
  });
}

function readJsonFile(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} did not contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function writeJsonFile(path: string, value: Record<string, unknown>): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function formatTypeScriptDiagnostic(diagnostic: ts.Diagnostic): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  if (diagnostic.file === undefined || diagnostic.start === undefined) return message;
  const location = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return `${diagnostic.file.fileName}:${location.line + 1}:${location.character + 1} ${message}`;
}

function typecheckConsumerProject(configurationPath: string): readonly string[] {
  const configuration = ts.readConfigFile(configurationPath, ts.sys.readFile);
  if (configuration.error !== undefined) return [formatTypeScriptDiagnostic(configuration.error)];
  const parsed = ts.parseJsonConfigFileContent(
    configuration.config,
    ts.sys,
    resolve(configurationPath, '..'),
  );
  if (parsed.errors.length > 0) return parsed.errors.map(formatTypeScriptDiagnostic);
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
  });
  return ts.getPreEmitDiagnostics(program).map(formatTypeScriptDiagnostic);
}

function preparePackedWorkspace(root: string): string {
  const packageDirectory = join(root, 'packages', 'weft');
  const typescriptDirectory = join(root, 'internal', 'typescript');
  copyDirectory(PACKAGE_ROOT, packageDirectory);
  copyDirectory(join(REPOSITORY_ROOT, 'internal', 'typescript'), typescriptDirectory);

  const rootPackageJsonPath = join(root, 'package.json');
  const rootPackageJson = readJsonFile(join(REPOSITORY_ROOT, 'package.json'));
  rootPackageJson['workspaces'] = ['packages/weft', 'internal/typescript'];
  writeJsonFile(rootPackageJsonPath, rootPackageJson);
  cpSync(join(REPOSITORY_ROOT, 'bun.lock'), join(root, 'bun.lock'));

  const packageJsonPath = join(packageDirectory, 'package.json');
  const packageJson = readJsonFile(packageJsonPath);
  packageJson['version'] = PACKED_FIXTURE_VERSION;
  const devDependencies = packageJson['devDependencies'];
  if (
    devDependencies === null ||
    typeof devDependencies !== 'object' ||
    Array.isArray(devDependencies)
  ) {
    throw new Error('expected @lostgradient/weft package.json devDependencies to be an object');
  }
  (devDependencies as Record<string, unknown>)['@lostgradient/typescript'] = PACKED_FIXTURE_VERSION;
  writeJsonFile(packageJsonPath, packageJson);

  const typescriptPackageJsonPath = join(typescriptDirectory, 'package.json');
  const typescriptPackageJson = readJsonFile(typescriptPackageJsonPath);
  typescriptPackageJson['version'] = PACKED_FIXTURE_VERSION;
  writeJsonFile(typescriptPackageJsonPath, typescriptPackageJson);

  return packageDirectory;
}

async function packWeftTarball(root: string): Promise<string> {
  const packageDirectory = preparePackedWorkspace(root);

  const tarballPath = join(root, 'weft-packed-fixture.tgz');
  const pack = await runProcess(
    [process.execPath, 'pm', 'pack', '--quiet', '--ignore-scripts', '--filename', tarballPath],
    packageDirectory,
  );
  expect(pack.exitCode, pack.stderr).toBe(0);
  expect(pack.stdout).toBe(tarballPath);
  expect(existsSync(tarballPath)).toBe(true);

  const packageJson = await runProcess(['tar', '-xOf', tarballPath, 'package/package.json'], root);
  expect(packageJson.exitCode, packageJson.stderr).toBe(0);
  const packedManifest = JSON.parse(packageJson.stdout) as { name?: unknown; version?: unknown };
  expect(packedManifest.name).toBe('@lostgradient/weft');
  expect(packedManifest.version).toBe(PACKED_FIXTURE_VERSION);

  return tarballPath;
}

function writePackedConsumerFixture(
  consumerDirectory: string,
  tarballPath: string,
): {
  readonly generatedWorkerPath: string;
  readonly registryPath: string;
} {
  mkdirSync(consumerDirectory, { recursive: true });
  const packageJson = {
    private: true,
    type: 'module',
    dependencies: {
      '@lostgradient/weft': `file:${tarballPath}`,
    },
  };
  writeJsonFile(join(consumerDirectory, 'package.json'), packageJson);
  writeJsonFile(join(consumerDirectory, 'tsconfig.json'), {
    compilerOptions: {
      target: 'ES2022',
      lib: ['ESNext', 'DOM', 'DOM.Iterable'],
      module: 'ESNext',
      moduleResolution: 'bundler',
      allowImportingTsExtensions: true,
      verbatimModuleSyntax: true,
      isolatedModules: true,
      noEmit: true,
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      noImplicitReturns: true,
      noFallthroughCasesInSwitch: true,
      noPropertyAccessFromIndexSignature: true,
      types: ['bun'],
      typeRoots: [
        join(PACKAGE_ROOT, 'node_modules', '@types'),
        join(REPOSITORY_ROOT, 'node_modules', '@types'),
      ],
      skipLibCheck: true,
    },
    include: ['*.ts'],
  });

  const registryPath = join(consumerDirectory, 'registry.json');
  const registry = readFileSync(REGISTRY_FIXTURE, 'utf8');
  writeFileSync(registryPath, registry);

  const generatedWorkerPath = join(consumerDirectory, 'weft-worker.generated.ts');
  writeFileSync(
    join(consumerDirectory, 'consumer.ts'),
    [
      "import { defineGeneratedWorker } from './weft-worker.generated.ts';",
      "import { defineWorker } from '@lostgradient/weft/worker/generated-authoring';",
      '',
      'const directWorker = defineWorker({ deployment: "packed-consumer-direct", workflows: {} });',
      'if (directWorker.deployment !== "packed-consumer-direct") throw new Error("direct worker export failed");',
      '',
      'const generatedWorker = defineGeneratedWorker({',
      '  deployment: "packed-consumer-generated",',
      '  workflows: {',
      '    farewell: { name: "farewell", activities: {} },',
      '    welcome: { name: "welcome", activities: {} },',
      '  },',
      '});',
      'if (generatedWorker.workflows.welcome.name !== "welcome") throw new Error("generated worker import failed");',
      '',
      "const resolved = Bun.resolveSync('@lostgradient/weft/worker/generated-authoring', import.meta.dir);",
      'console.log(JSON.stringify({',
      '  resolved,',
      '  workflows: Object.keys(generatedWorker.workflows).toSorted(),',
      '}));',
      '',
    ].join('\n'),
  );

  return { generatedWorkerPath, registryPath };
}

type PackedConsumerFixture = {
  readonly consumerDirectory: string;
  readonly generatedWorkerPath: string;
  readonly registryPath: string;
  readonly tarballPath: string;
};

type PackedTarballFixture = {
  readonly root: string;
  readonly tarballPath: string;
};

let packedTarballFixturePromise: Promise<PackedTarballFixture> | undefined;
let packedConsumerFixturePromise: Promise<PackedConsumerFixture> | undefined;

async function getPackedTarballFixture(): Promise<PackedTarballFixture> {
  packedTarballFixturePromise ??= createPackedTarballFixture();
  return packedTarballFixturePromise;
}

async function getPackedConsumerFixture(): Promise<PackedConsumerFixture> {
  packedConsumerFixturePromise ??= createPackedConsumerFixture();
  return packedConsumerFixturePromise;
}

async function createPackedTarballFixture(): Promise<PackedTarballFixture> {
  const root = makePersistentTempDir();
  const tarballPath = await packWeftTarball(root);
  return { root, tarballPath };
}

async function createPackedConsumerFixture(): Promise<PackedConsumerFixture> {
  const { root, tarballPath } = await getPackedTarballFixture();
  const consumerDirectory = join(root, 'consumer');
  const { generatedWorkerPath, registryPath } = writePackedConsumerFixture(
    consumerDirectory,
    tarballPath,
  );

  const install = await runProcess(
    [process.execPath, ...PACKED_CONSUMER_INSTALL_ARGUMENTS],
    consumerDirectory,
  );
  expect(install.exitCode, install.stderr).toBe(0);

  const codegen = await runProcess(
    [
      process.execPath,
      join(consumerDirectory, 'node_modules', '.bin', 'weft'),
      'codegen',
      '--from',
      registryPath,
      '--target',
      'worker',
      '--out',
      generatedWorkerPath,
    ],
    consumerDirectory,
  );
  expect(codegen.exitCode, codegen.stderr).toBe(0);

  return { consumerDirectory, generatedWorkerPath, registryPath, tarballPath };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

afterAll(() => {
  for (const dir of persistentTempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('executeCodegen end-to-end', () => {
  it('emits the expected .d.ts from the registry fixture', async () => {
    const dir = makeTempDir();
    const out = join(dir, 'weft.d.ts');
    const result = await executeCodegen({ from: REGISTRY_FIXTURE, out, timeoutMs: 30_000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('codegen: wrote');
    const written = await Bun.file(out).text();
    expect(written).toBe(await readGolden());
  });

  it('augments the module name this package is published under, not a hardcoded one', async () => {
    // The generated declaration is only useful if `declare module '…'` names
    // the specifier the consumer types, which is this package's published
    // name. Asserting against the manifest rather than against the string the
    // checkout happens to use is what makes this fail if the emitter ever goes
    // back to a literal: a literal survives being republished under another
    // name, and the manifest does not.
    const dir = makeTempDir();
    const out = join(dir, 'weft.d.ts');
    const result = await executeCodegen({ from: REGISTRY_FIXTURE, out, timeoutMs: 30_000 });
    expect(result.exitCode).toBe(0);
    const written = await Bun.file(out).text();
    expect(codegenPackageName).toBe(manifest.name);
    expect(written).toContain(`declare module '${manifest.name}' {`);
  });

  it('keeps the tsc typecheck fixture (weft.generated.d.ts) in sync with expected.d.txt', async () => {
    // `codegen-typecheck.test.ts` feeds `weft.generated.d.ts` to a real `tsc`
    // subprocess as a structural proof that the generated `.d.ts` actually
    // compiles (in particular the alias-hoisting this batch adds). That file
    // is hand-maintained, independent of this test's `executeCodegen` ->
    // `expected.d.txt` pipeline, so nothing previously tethered the two
    // together: a future registry/schema change updated here without a
    // matching manual edit there would leave the `tsc` proof silently
    // compiling stale content while this file's string assertions still
    // passed. Byte-comparing them here makes that drift fail loudly instead.
    //
    // The fixture keeps a real package name rather than the golden's
    // placeholder because `tsc` has to parse it, and the mirror transform
    // rewrites that name along with every other module specifier it emits.
    const typecheckFixture = await Bun.file(TYPECHECK_GENERATED_DTS).text();
    expect(typecheckFixture).toBe(await readGolden());
  });

  it('reports "up to date" on the second run and does not rewrite content', async () => {
    const dir = makeTempDir();
    const out = join(dir, 'weft.d.ts');
    await executeCodegen({ from: REGISTRY_FIXTURE, out, timeoutMs: 30_000 });
    const first = await Bun.file(out).text();

    const second = await executeCodegen({ from: REGISTRY_FIXTURE, out, timeoutMs: 30_000 });
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain('is up to date');
    const after = await Bun.file(out).text();
    expect(after).toBe(first);
  });

  it('codegen output is identical for two snapshots differing only in generatedAt', async () => {
    // generatedAt is informational only — it must not affect the generated
    // declaration (acceptance criterion: "generatedAt must not affect
    // generated declarations or drift checks").
    const dir = makeTempDir();
    const raw = await Bun.file(REGISTRY_FIXTURE).text();

    const early = join(dir, 'early.json');
    writeFileSync(
      early,
      raw.replace(
        '"generatedAt": "2026-01-01T00:00:00.000Z"',
        '"generatedAt": "2020-06-15T12:34:56.000Z"',
      ),
    );
    const late = join(dir, 'late.json');
    writeFileSync(
      late,
      raw.replace(
        '"generatedAt": "2026-01-01T00:00:00.000Z"',
        '"generatedAt": "2030-11-30T23:59:59.999Z"',
      ),
    );

    const outEarly = join(dir, 'early.d.ts');
    const outLate = join(dir, 'late.d.ts');
    const resultEarly = await executeCodegen({ from: early, out: outEarly, timeoutMs: 30_000 });
    const resultLate = await executeCodegen({ from: late, out: outLate, timeoutMs: 30_000 });
    expect(resultEarly.exitCode).toBe(0);
    expect(resultLate.exitCode).toBe(0);
    expect(await Bun.file(outEarly).text()).toBe(await Bun.file(outLate).text());
  });

  it('emits a worker target without importing executable workflow modules', async () => {
    const dir = makeTempDir();
    const out = join(dir, 'weft-worker.generated.ts');
    const result = await executeCodegen({
      from: REGISTRY_FIXTURE,
      out,
      target: 'worker',
      timeoutMs: 30_000,
    });

    expect(result.exitCode).toBe(0);
    const written = await Bun.file(out).text();
    expect(written).toContain('defineGeneratedWorker');
    expect(written).toContain("from '@lostgradient/weft/worker/generated-authoring'");
    expect(written).not.toContain("from './");
  });

  it('revalidates registry manifests when installing the packed consumer', () => {
    expect(PACKED_CONSUMER_INSTALL_ARGUMENTS).not.toContain('--prefer-offline');
    expect(PACKED_CONSUMER_INSTALL_ARGUMENTS).not.toContain('--offline');
  });

  it('packs a @lostgradient/weft tarball with the expected package identity', async () => {
    const { tarballPath } = await getPackedTarballFixture();
    expect(tarballPath.endsWith('weft-packed-fixture.tgz')).toBe(true);
    expect(existsSync(tarballPath)).toBe(true);
  });

  it('runs packed CLI codegen from an isolated packed consumer without workspace fallback', async () => {
    const { consumerDirectory, generatedWorkerPath, tarballPath } =
      await getPackedConsumerFixture();

    const installedManifest = readJsonFile(
      join(consumerDirectory, 'node_modules', '@lostgradient', 'weft', 'package.json'),
    );
    expect(installedManifest['name']).toBe('@lostgradient/weft');
    expect(installedManifest['version']).toBe(PACKED_FIXTURE_VERSION);
    expect(tarballPath.endsWith('weft-packed-fixture.tgz')).toBe(true);
    expect(existsSync(join(consumerDirectory, 'node_modules', '.bin', 'weft'))).toBe(true);
    const generated = await Bun.file(generatedWorkerPath).text();
    expect(generated).toContain("from '@lostgradient/weft/worker/generated-authoring'");
    expect(generated).toContain('defineGeneratedWorker');

    const resolution = await runProcess(
      [
        process.execPath,
        '--print',
        `Bun.resolveSync('@lostgradient/weft/worker/generated-authoring', ${JSON.stringify(consumerDirectory)})`,
      ],
      consumerDirectory,
    );
    expect(resolution.exitCode, resolution.stderr).toBe(0);
    expect(
      realpathSync(resolution.stdout).startsWith(
        realpathSync(join(consumerDirectory, 'node_modules')),
      ),
      resolution.stdout,
    ).toBe(true);
    expect(resolution.stdout).not.toContain(PACKAGE_ROOT);
  });

  it('typechecks generated worker code against the packed artifact', async () => {
    const { consumerDirectory } = await getPackedConsumerFixture();

    const diagnostics = typecheckConsumerProject(join(consumerDirectory, 'tsconfig.json'));
    expect(diagnostics).toEqual([]);
  });

  it('executes generated worker code against the packed artifact', async () => {
    const { consumerDirectory } = await getPackedConsumerFixture();

    const execution = await runProcess(
      [process.execPath, '--no-install', join(consumerDirectory, 'consumer.ts')],
      consumerDirectory,
    );
    expect(execution.exitCode, execution.stderr).toBe(0);
    const proof = JSON.parse(execution.stdout) as {
      readonly resolved?: unknown;
      readonly workflows?: unknown;
    };
    expect(proof.workflows).toEqual(['farewell', 'welcome']);
    if (typeof proof.resolved !== 'string') {
      throw new Error(`expected resolver proof to be a string, received ${String(proof.resolved)}`);
    }
    expect(
      realpathSync(proof.resolved).startsWith(
        realpathSync(join(consumerDirectory, 'node_modules')),
      ),
    ).toBe(true);
    expect(proof.resolved).not.toContain(PACKAGE_ROOT);
  });

  it('fails with a clear diagnostic on registry version mismatch and writes no output', async () => {
    const dir = makeTempDir();
    const bad = join(dir, 'bad.json');
    const out = join(dir, 'weft.d.ts');
    const raw = await Bun.file(REGISTRY_FIXTURE).text();
    writeFileSync(bad, raw.replace('"registryVersion": 2', '"registryVersion": 3'));
    const result = await executeCodegen({ from: bad, out, timeoutMs: 30_000 });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('registryVersion 3');
    expect(existsSync(out)).toBe(false);
  });

  it('rejects a v1 snapshot with a clear upgrade diagnostic (no compatibility layer)', async () => {
    const dir = makeTempDir();
    const out = join(dir, 'weft.d.ts');
    const v1 = join(dir, 'v1.json');
    writeFileSync(
      v1,
      JSON.stringify({
        registryVersion: 1,
        workflows: { welcome: { inputSchema: { type: 'string' } } },
        activities: {},
      }),
    );
    const result = await executeCodegen({ from: v1, out, timeoutMs: 30_000 });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      'codegen: registryVersion 1 is not supported (expected 2); upgrade or regenerate the snapshot',
    );
    expect(existsSync(out)).toBe(false);
  });

  it('fails when --from points at a missing file', async () => {
    const dir = makeTempDir();
    const out = join(dir, 'weft.d.ts');
    const missing = join(dir, 'no-such-file.json');
    const result = await executeCodegen({ from: missing, out, timeoutMs: 30_000 });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--from file not found');
    expect(existsSync(out)).toBe(false);
  });

  it('fails on malformed JSON without writing partial output', async () => {
    const dir = makeTempDir();
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{ not valid json');
    const out = join(dir, 'weft.d.ts');
    const result = await executeCodegen({ from: bad, out, timeoutMs: 30_000 });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('failed to parse JSON');
    expect(existsSync(out)).toBe(false);
  });
});

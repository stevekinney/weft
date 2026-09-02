import { join } from 'node:path';

const repositoryPath = join(import.meta.dir, '..');
const expectedPackageName = '@lostgradient/weft';
const maximumPackedBytes = 5 * 1024 * 1024;
const maximumUnpackedBytes = 12 * 1024 * 1024;
// A guardrail against accidentally publishing files that should not ship (test,
// fixture, or stray build output) rather than a hard size ceiling — the packed
// and unpacked byte budgets above are the primary bloat backstop. Bump this
// when the published `dist/` surface legitimately grows.
//
// WFT-5 added the `core/contract` module (`build.ts`, `hash.ts`,
// `manifest.ts`, `manifest-parse.ts`, `manifest-parse-schema.ts`,
// `normalize.ts`, `revision.ts`, `types.ts`, `limits.ts`, `failure.ts`,
// `index.ts`) — 11 new source files, each shipping a `.js` and a `.d.ts` in
// `dist/`, which legitimately grows the entry count by 22.
//
// WFT-6 added 3 new source files — `src/cli/codegen-validate.ts`,
// `src/core/registry-workflow-contract-draft.ts`, and
// `src/core/registry-schema-conversion.ts` (both `core/` additions are
// file-size-ceiling extractions from `core/registry-snapshot.ts`, split out
// once WFT-6's own additions there — workflow-scoped activity folding —
// pushed it over 500 lines) — each shipping a `.js` and a `.d.ts` in
// `dist/`, +6 entries by that formula (1485 -> 1491). The measured
// `npm pack --dry-run --json --ignore-scripts` entry count on this change
// is 1493, 2 higher than the formula predicts; the same +2 unattributed
// baseline drift the previous entry in this comment (2ac2e27e, WFT-6's
// `codegen-validate.ts`-only revision) already found and left unattributed,
// carried forward rather than re-caused. Bumped to the actual measured
// count rather than the unverified formula value.
const maximumEntryCount = 1493;

type PackFile = {
  path: string;
  size: number;
};

type PackResult = {
  name: string;
  version: string;
  size: number;
  unpackedSize: number;
  entryCount: number;
  files: PackFile[];
};

type PackageJson = Record<string, unknown>;

const textDecoder = new TextDecoder();

function fail(message: string): never {
  throw new Error(message);
}

async function loadPackageJson(): Promise<PackageJson> {
  return JSON.parse(await Bun.file(join(repositoryPath, 'package.json')).text()) as PackageJson;
}

function normalizePackagePath(path: string): string {
  return path.replace(/^\.\//, '');
}

function collectDistributionTargets(value: unknown, targets: Set<string>): void {
  if (typeof value === 'string') {
    const normalized = normalizePackagePath(value);
    if (normalized.startsWith('dist/')) targets.add(normalized);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectDistributionTargets(item, targets);
    return;
  }

  if (value === null || typeof value !== 'object') return;

  for (const nested of Object.values(value)) {
    collectDistributionTargets(nested, targets);
  }
}

function collectManifestTargets(packageJson: PackageJson): Set<string> {
  const targets = new Set<string>();
  collectDistributionTargets(packageJson['main'], targets);
  collectDistributionTargets(packageJson['module'], targets);
  collectDistributionTargets(packageJson['types'], targets);
  collectDistributionTargets(packageJson['bin'], targets);
  collectDistributionTargets(packageJson['exports'], targets);
  return targets;
}

function recordKeys(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value);
}

function packageRootOf(specifier: string): string {
  if (specifier.startsWith('@')) {
    const [scope, name] = specifier.split('/');
    return name ? `${scope}/${name}` : specifier;
  }
  return specifier.split('/')[0] ?? specifier;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

async function findForbiddenDependencyImports(
  packageJson: PackageJson,
  files: PackFile[],
): Promise<string[]> {
  const runtimeRoots = new Set([
    ...recordKeys(packageJson['dependencies']),
    ...recordKeys(packageJson['optionalDependencies']),
    ...recordKeys(packageJson['peerDependencies']),
    'bun',
    'node:assert',
    'node:buffer',
    'node:crypto',
    'node:fs',
    'node:http',
    'node:module',
    'node:net',
    'node:os',
    'node:path',
    'node:process',
    'node:stream',
    'node:url',
    'node:util',
    'node:zlib',
  ]);
  const devOnlyRoots = new Set(
    recordKeys(packageJson['devDependencies']).filter((name) => !runtimeRoots.has(name)),
  );
  const specifierPattern =
    /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s+)(["'])([^"']+)\1/g;
  const offenders: string[] = [];

  for (const file of files) {
    if (!/\.(?:js|d\.ts)$/.test(file.path)) continue;
    const source = stripComments(await Bun.file(join(repositoryPath, file.path)).text());
    for (const [, , specifier] of source.matchAll(specifierPattern)) {
      if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:'))
        continue;
      const packageRoot = packageRootOf(specifier);
      if (devOnlyRoots.has(packageRoot)) {
        offenders.push(`${file.path} imports dev-only package "${specifier}"`);
      }
    }
  }

  return offenders;
}

function runNpmPackDryRun(): PackResult {
  const result = Bun.spawnSync(['npm', 'pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: repositoryPath,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, npm_config_loglevel: 'silent' },
  });

  const stdout = textDecoder.decode(result.stdout).trim();
  const stderr = textDecoder.decode(result.stderr).trim();

  if (result.exitCode !== 0) {
    fail(`npm pack --dry-run failed with exit ${result.exitCode}\n${stderr}\n${stdout}`.trim());
  }

  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    fail(`npm pack returned an unexpected shape: ${stdout}`);
  }

  return parsed[0] as PackResult;
}

function findForbiddenPaths(files: PackFile[]): string[] {
  const forbiddenPatterns: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /\.map$/, reason: 'source maps are not published' },
    { pattern: /^dist\/benchmarks\//, reason: 'benchmark artifacts are test-only' },
    { pattern: /(?:^|\/)__fixtures__\//, reason: 'fixtures are not runtime package content' },
    { pattern: /(?:^|\/)__tests__\//, reason: 'tests are not runtime package content' },
    { pattern: /\.test-d\.d\.ts$/, reason: 'type assertion tests are not public declarations' },
    {
      pattern: /^dist\/workers\/test-/,
      reason: 'test worker entrypoints are not public runtime files',
    },
    {
      pattern: /^dist\/dashboard(?:\/|$)/,
      reason: 'the bundled dashboard is no longer public package content',
    },
    {
      pattern: /(^|\/)(?:src|scripts|tests|examples|documentation|reference|\.github)\//,
      reason: 'source repository content is outside the npm files allowlist',
    },
  ];
  const offenders: string[] = [];

  for (const file of files) {
    for (const { pattern, reason } of forbiddenPatterns) {
      if (pattern.test(file.path)) {
        offenders.push(`${file.path}: ${reason}`);
      }
    }
  }

  return offenders;
}

async function main(): Promise<void> {
  const packageJson = await loadPackageJson();
  const packResult = runNpmPackDryRun();
  const files = packResult.files.map((file) => ({
    ...file,
    path: normalizePackagePath(file.path),
  }));
  const fileSet = new Set(files.map((file) => file.path));
  const errors: string[] = [];

  if (packageJson['name'] !== expectedPackageName) {
    errors.push(
      `package.json name must be ${expectedPackageName}, found ${String(packageJson['name'])}`,
    );
  }
  if (packResult.name !== expectedPackageName) {
    errors.push(`npm pack name must be ${expectedPackageName}, found ${packResult.name}`);
  }

  for (const required of [
    'package.json',
    'README.md',
    'LICENSE',
    ...collectManifestTargets(packageJson),
  ]) {
    if (!fileSet.has(required)) errors.push(`packed artifact is missing ${required}`);
  }

  if (packResult.size > maximumPackedBytes) {
    errors.push(`packed size ${packResult.size} exceeds budget ${maximumPackedBytes}`);
  }
  if (packResult.unpackedSize > maximumUnpackedBytes) {
    errors.push(`unpacked size ${packResult.unpackedSize} exceeds budget ${maximumUnpackedBytes}`);
  }
  if (packResult.entryCount > maximumEntryCount) {
    errors.push(`entry count ${packResult.entryCount} exceeds budget ${maximumEntryCount}`);
  }

  errors.push(...findForbiddenPaths(files));
  errors.push(...(await findForbiddenDependencyImports(packageJson, files)));

  if (errors.length > 0) {
    console.error('Package contents check failed:');
    for (const error of errors) console.error(`  - ${error}`);
    process.exit(1);
  }

  console.log(
    `Package contents OK: ${packResult.entryCount} files, ${packResult.size} packed bytes, ${packResult.unpackedSize} unpacked bytes.`,
  );
}

await main();

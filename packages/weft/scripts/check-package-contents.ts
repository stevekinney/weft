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
//
// WFT-6's second review round added a 4th new source file,
// `src/core/registry-limits.ts` (the `MAX_REGISTRY_WORKFLOW_COUNT`
// constant and `RegistryWorkflowCountLimitError`, shared between the
// producer in `registry-snapshot.ts` and the consumer in
// `codegen-validate.ts` so the two ceilings can never drift apart) — one
// more `.js`/`.d.ts` pair, +2 entries (1493 -> 1495).
//
// WFT-6's third review round (fixing `buildWorkerManifestFromRegistry()`'s
// unrelated-registration blast radius, see CHANGELOG.md) split two more
// files out of `registry-snapshot.ts`: `src/core/compare-codepoint.ts`
// (the shared codepoint comparator, extracted to avoid an import cycle)
// and `src/core/registry-workflow-manifest.ts` (`buildWorkflowManifestForType`
// and the per-workflow entry/message/scoped-activity builders it and
// `buildRegistrySnapshot` both call) — two more `.js`/`.d.ts` pairs, +4
// entries (1495 -> 1499).
//
// WFT-8 added `src/core/contract/compatibility.ts` (`checkWorkflowCompatibility()`,
// `WorkflowCompatibilityVerdict`/`WorkflowCompatibilityReason`/`WorkflowCompatibilityPolicy`,
// `DEFAULT_WORKFLOW_COMPATIBILITY_POLICY`) — one new source file, one more
// `.js`/`.d.ts` pair in `dist/`, +2 entries (1499 -> 1501), matching the
// measured `npm pack --dry-run --json --ignore-scripts` count exactly.
//
// WFT-7 (merged as #946, landed on `main` after WFT-8's branch point) split
// two new source files out of `codegen-emit.ts`: `src/cli/codegen-emit-dedup.ts`
// (the shared-schema hoisting pass) and `src/cli/codegen-emit-registry.ts`
// (the `WorkflowRegistry` interface emitter) — two more `.js`/`.d.ts` pairs,
// +4 entries (1501 -> 1505), matching the measured count after rebasing
// WFT-8 onto WFT-7.
// WFT-84 added the application mailbox modules (24 source files, each a
// `.js`/`.d.ts` pair); the surface merged with WFT-6, WFT-7, and WFT-8
// measured 1551 by `npm pack --dry-run`, and 1567 after merging WFT-9/WFT-10
// (#947, the durable workflow catalog). WFT-85's extraction of the shared
// application primitives (three new modules, one retired) reports 1571.
//
// This budget was not bumped again for WFT-11 (#949, 7 new non-test source
// files: `engine-workflows-namespace.ts` + 6 `server/operations/*.ts`
// catalog operations) or WFT-12 (#948, 6 new non-test source files under
// `core/catalog/`, `core/engine/`, `core/events/`) — `check:package-contents`
// only runs from `bun run prepack`, which only `release.yaml` invokes (never
// PR CI), so neither PR's own verification loop ever exercised this gate.
// WFT-13/14 (dynamic workflow sources) discovered the accumulated drift
// while running `prepack` as an extra, non-required verification step: 8
// more new non-test source files of its own (`core/source/{index,types,
// workflow-source,errors,resolvers,validate}.ts`,
// `core/engine/source-{registration,resolution}.ts`), +16 by the
// `.js`/`.d.ts`-pair formula, on top of the ~28 entries from WFT-11/WFT-12's
// unreconciled additions above. Bumped to the actual measured
// `npm pack --dry-run --json --ignore-scripts` entry count (1615) rather
// than attempting to reconstruct the exact per-batch formula for three
// PRs' worth of unreconciled drift.
// WFT-85's outbox then adds its modules, the shared payload validators, and
// the shared timing helpers on top of that; `prepack` on the merged tree
// reports 1665.
// WFT-15 through WFT-20 subsequently split revision-pinning, dynamic-source,
// and task-dispatch responsibilities into focused implementation modules.
// Those merged changes add 60 shipped `.js`/`.d.ts` entries; `npm pack
// --dry-run --json --ignore-scripts` reports 1725 on the resulting tree.
// WFT-90 splits `storage/interface.ts` into four extracted key modules
// (`workflow-record-keys.ts`, `workflow-lifecycle-keys.ts`, `signal-keys.ts`,
// `lease-keys.ts`), each shipping as a `.js`/`.d.ts` pair: +8 entries. `npm
// pack --dry-run --json --ignore-scripts` reports 1733 on the resulting tree.
// WFT-153 adds the durable per-id generation fence — `generation-codec.ts`,
// `core/engine/workflow-generation-fence.ts`, and `storage/generation-keys.ts`
// — plus `lifecycle/start-schedule-timing.ts`, split out of `lifecycle/start.ts`
// while rebasing onto WFT-90/WFT-95/WFT-134 to keep that file under the
// 500-line ceiling: 4 new source files, each shipping a `.js`/`.d.ts` pair,
// +8 entries by the formula. Measuring `npm pack --dry-run --json
// --ignore-scripts` directly on the merged WFT-90 baseline tree (028ade84,
// before this PR's own commits) reports 1737, 4 higher than this file's
// previous 1733 — unattributed drift from `main` between when that comment
// was written and this rebase, carried forward rather than re-investigated,
// matching this comment's own established practice for prior unreconciled
// drift (see the WFT-6 entries above). 1737 + 8 = 1745, the measured count on
// this PR's own resulting tree.
// Bumped again for the v0.25.0 release (WFT-21): #963 added compiled
// modules for fork/replay/purge revision-reference-accounting work
// (`revision-unavailable-fault.ts`, `fork-source-replaced-error.ts`,
// `fork-source-replacement-guards.ts`, and related helpers), each shipping
// a `.js`/`.d.ts` pair. `bun run prepack` measured 1757 entries on this
// release's own resulting tree (pinned to the CI-matching Bun 1.4.0).
const maximumEntryCount = 1757;

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

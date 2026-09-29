import fs from 'node:fs';
import path from 'node:path';

export class SnapshotPreparationError extends Error {}

const mirrorSnapshotActor = 'lost-gradient-mirror-sync[bot]';
const mirrorSnapshotBranch =
  /^refs\/heads\/mirror-sync-[0-9a-f]{12}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function snapshotVersionFor(options: {
  sourceVersion: string;
  runId: string;
  runAttempt: string;
}): string {
  if (!/^\d+\.\d+\.\d+$/.test(options.sourceVersion)) {
    throw new SnapshotPreparationError(
      `Snapshot source version must be a stable semver version, received ${options.sourceVersion}`,
    );
  }
  if (!/^\d+$/.test(options.runId) || Number(options.runId) < 1) {
    throw new SnapshotPreparationError(
      `Snapshot run ID must be a positive integer, received ${options.runId}`,
    );
  }
  if (!/^\d+$/.test(options.runAttempt) || Number(options.runAttempt) < 1) {
    throw new SnapshotPreparationError(
      `Snapshot run attempt must be a positive integer, received ${options.runAttempt}`,
    );
  }
  return `${options.sourceVersion}-next.${options.runId}.${options.runAttempt}`;
}

export function assertSnapshotRef(options: {
  actor: string;
  expectedSha: string;
  githubSha: string;
  headSha: string;
  ref: string;
}): void {
  if (options.actor !== mirrorSnapshotActor) {
    throw new SnapshotPreparationError(
      `Snapshot dispatch actor must be ${mirrorSnapshotActor}, received ${options.actor}`,
    );
  }
  if (!/^[0-9a-f]{40}$/i.test(options.expectedSha)) {
    throw new SnapshotPreparationError('expected_sha must be a 40-character commit SHA');
  }
  const expectedSha = options.expectedSha.toLowerCase();
  if (options.githubSha.toLowerCase() !== expectedSha) {
    throw new SnapshotPreparationError(
      `Dispatch SHA mismatch: github.sha=${options.githubSha}, expected_sha=${options.expectedSha}`,
    );
  }
  if (options.headSha.toLowerCase() !== expectedSha) {
    throw new SnapshotPreparationError(
      `Checked-out commit mismatch: HEAD=${options.headSha}, expected_sha=${options.expectedSha}`,
    );
  }
  if (options.ref !== 'refs/heads/main' && !mirrorSnapshotBranch.test(options.ref)) {
    throw new SnapshotPreparationError(
      `Snapshot dispatch ref is not mirror-controlled, received ${options.ref}`,
    );
  }
}

function readPackageVersion(packagePath: string): string {
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { version?: unknown };
  if (typeof packageJson.version !== 'string') {
    throw new SnapshotPreparationError('package.json is missing a string version');
  }
  return packageJson.version;
}

function updatePackageVersion(packagePath: string, version: string): void {
  const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { version?: string };
  packageJson.version = version;
  fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

function updateExportedVersion(versionPath: string, sourceVersion: string, version: string): void {
  const source = fs.readFileSync(versionPath, 'utf8');
  const updated = source.replace(
    `export const VERSION = '${sourceVersion}';`,
    `export const VERSION = '${version}';`,
  );
  if (updated === source) {
    throw new SnapshotPreparationError(
      `src/version.ts does not export source version ${sourceVersion}`,
    );
  }
  fs.writeFileSync(versionPath, updated);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new SnapshotPreparationError(`Missing required environment variable ${name}`);
  return value;
}

if (import.meta.main) {
  const packagePath = path.join(process.cwd(), 'package.json');
  const versionPath = path.join(process.cwd(), 'src/version.ts');
  const sourceVersion = readPackageVersion(packagePath);
  const exportedVersion = fs
    .readFileSync(versionPath, 'utf8')
    .match(/export const VERSION = '([^']+)'/)?.[1];
  if (exportedVersion !== sourceVersion) {
    throw new SnapshotPreparationError(
      `Source version mismatch: package.json=${sourceVersion}, src/version.ts=${exportedVersion ?? '<missing>'}`,
    );
  }

  const head = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'pipe' });
  if (head.exitCode !== 0) throw new SnapshotPreparationError('Unable to resolve checked-out HEAD');
  const headSha = new TextDecoder().decode(head.stdout).trim();
  assertSnapshotRef({
    actor: requiredEnvironment('DISPATCH_ACTOR'),
    expectedSha: requiredEnvironment('EXPECTED_SHA'),
    githubSha: requiredEnvironment('DISPATCH_SHA'),
    headSha,
    ref: requiredEnvironment('DISPATCH_REF'),
  });

  const version = snapshotVersionFor({
    sourceVersion,
    runId: requiredEnvironment('GITHUB_RUN_ID'),
    runAttempt: requiredEnvironment('GITHUB_RUN_ATTEMPT'),
  });
  updatePackageVersion(packagePath, version);
  updateExportedVersion(versionPath, sourceVersion, version);
  console.log(`Prepared snapshot version ${version} from ${sourceVersion} at ${headSha}`);
}

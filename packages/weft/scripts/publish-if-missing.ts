import fs from 'node:fs';
import path from 'node:path';

export class PublishError extends Error {}

export interface CommandOptions {
  cwd: string;
  /** Variables layered over the process environment for this one command. */
  environment?: Record<string, string> | undefined;
  /** Show the command's output as it runs instead of capturing it. */
  stream?: boolean | undefined;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: readonly string[],
  options: CommandOptions,
) => CommandResult | Promise<CommandResult>;

export interface PublishIfMissingOptions {
  /** `packages/weft`: where every npm and Bun command runs. */
  packageRoot: string;
  /** The repository root: where every git command runs. */
  repositoryRoot: string;
  name: string;
  version: string;
  run: CommandRunner;
  log: (line: string) => void;
  /**
   * The file changesets/action v2 reads to learn what a custom publish script published
   * (`CHANGESETS_OUTPUT`). Unset outside the action.
   */
  outputFile?: string | undefined;
}

const commitIdPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// Annotated tags need an identity, and the Actions runner has none configured.
const taggerIdentity = [
  '-c',
  'user.name=github-actions[bot]',
  '-c',
  'user.email=41898282+github-actions[bot]@users.noreply.github.com',
];

function describeFailure(command: readonly string[], result: CommandResult): string {
  const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n');
  return `\`${command.join(' ')}\` exited ${result.exitCode}${detail ? `:\n${detail}` : ''}`;
}

function isNotFound(result: CommandResult): boolean {
  try {
    const parsed = JSON.parse(result.stdout) as { error?: { code?: string } };
    if (parsed.error?.code === 'E404') return true;
  } catch {
    // Not JSON: fall through to the plain-text form of the same error.
  }
  return /\bE404\b/.test(result.stderr);
}

async function expectSuccess(
  options: PublishIfMissingOptions,
  command: readonly string[],
  commandOptions: CommandOptions,
): Promise<CommandResult> {
  const result = await options.run(command, commandOptions);
  if (result.exitCode !== 0) throw new PublishError(describeFailure(command, result));
  return result;
}

async function tagAndPush(
  options: PublishIfMissingOptions,
  tag: string,
  commit: string | undefined,
): Promise<void> {
  const git = { cwd: options.repositoryRoot };
  await expectSuccess(
    options,
    [
      'git',
      ...taggerIdentity,
      'tag',
      '-a',
      tag,
      '-m',
      `Weft ${options.version}`,
      ...(commit ? [commit] : []),
    ],
    git,
  );
  await expectSuccess(options, ['git', 'push', 'origin', `refs/tags/${tag}`], git);
}

/** Whether the registry already has this exact version. Any answer but a 404 or a match throws. */
async function isPublished(options: PublishIfMissingOptions): Promise<boolean> {
  const command = ['npm', 'view', `${options.name}@${options.version}`, 'version', '--json'];
  const result = await options.run(command, { cwd: options.packageRoot });
  if (result.exitCode !== 0) {
    if (isNotFound(result)) return false;
    throw new PublishError(describeFailure(command, result));
  }
  let published: unknown;
  try {
    published = JSON.parse(result.stdout);
  } catch {
    published = undefined;
  }
  if (published === options.version) return true;
  throw new PublishError(
    `The registry answered with an unexpected version for ${options.name}@${options.version}: ` +
      `${result.stdout.trim() || '<empty>'}`,
  );
}

/** The commit a remote tag resolves to: the peeled line of an annotated tag, else the tag itself. */
function remoteTagTarget(listing: string, tag: string): string | undefined {
  let direct: string | undefined;
  for (const line of listing.split('\n')) {
    const [commit, reference] = line.trim().split(/\s+/);
    if (reference === `refs/tags/${tag}^{}`) return commit;
    if (reference === `refs/tags/${tag}`) direct = commit;
  }
  return direct;
}

/**
 * Reconcile the remote tag with the commit npm says published the version.
 *
 * A missing tag goes on `gitHead`. An existing tag must already point there: a tag on any other
 * commit is a discrepancy for a person to resolve, so it fails the run and is never moved.
 */
async function reconcileTag(options: PublishIfMissingOptions, tag: string): Promise<void> {
  const remote = await expectSuccess(options, ['git', 'ls-remote', '--tags', 'origin', tag], {
    cwd: options.repositoryRoot,
  });
  const existing = remoteTagTarget(remote.stdout, tag);
  const view = await expectSuccess(
    options,
    ['npm', 'view', `${options.name}@${options.version}`, 'gitHead'],
    { cwd: options.packageRoot },
  );
  const commit = view.stdout.trim();
  if (!commit) {
    options.log(
      `::warning::${options.name}@${options.version} is on npm but the registry records no ` +
        `gitHead, so ${tag} cannot be ${existing ? 'checked against it' : 'created'}. ` +
        (existing ? `${tag} points at ${existing}.` : 'Create the tag by hand.'),
    );
    return;
  }
  if (!commitIdPattern.test(commit)) {
    throw new PublishError(
      `The registry gitHead for ${options.version} is not a commit id: ${commit}`,
    );
  }
  if (existing) {
    if (existing.toLowerCase() !== commit.toLowerCase()) {
      throw new PublishError(
        `${tag} points at ${existing}, but ${options.name}@${options.version} was published from ` +
          `${commit}. Fix the tag by hand; it is not moved automatically.`,
      );
    }
    return;
  }
  options.log(`${tag} is missing from the remote; tagging ${commit}, the commit that published it`);
  await expectSuccess(options, ['git', 'fetch', 'origin', commit], { cwd: options.repositoryRoot });
  await tagAndPush(options, tag, commit);
}

/**
 * Publish `options.name@options.version` unless the registry already has it.
 *
 * Releases run on every push to main, and most pushes carry no new version. Asking the registry
 * first makes a re-run, a re-queued run, or a merge that changed no version a no-op instead of a
 * 403, and lets a run that published but failed to push its tag finish the job: the tag goes on
 * `gitHead`, the exact commit that published, never on whatever main has become since.
 */
export async function publishIfMissing(options: PublishIfMissingOptions): Promise<void> {
  const tag = `v${options.version}`;
  const packageCommand = { cwd: options.packageRoot, stream: true };
  // changesets/action warns when the file is absent, so a run that publishes nothing leaves it empty.
  if (options.outputFile) fs.appendFileSync(options.outputFile, '');

  if (await isPublished(options)) {
    options.log(`${options.name}@${options.version} is already on npm; skipping publish`);
    await reconcileTag(options, tag);
    return;
  }

  await expectSuccess(options, ['bun', 'run', 'scripts/verify-release-version.ts'], packageCommand);
  await expectSuccess(options, ['bun', 'run', 'prepack'], packageCommand);
  // Provenance is requested for the real publish only, as it was before releases moved here.
  await expectSuccess(options, ['npm', 'publish', '--dry-run', '--ignore-scripts'], {
    ...packageCommand,
    environment: { NPM_CONFIG_PROVENANCE: 'false' },
  });
  await expectSuccess(options, ['npm', 'publish', '--ignore-scripts'], packageCommand);
  // changesets/action v2 reads published packages from this file, not from the script's output.
  if (options.outputFile) {
    const event = { type: 'git-tag', tag, packageName: options.name };
    fs.appendFileSync(options.outputFile, `${JSON.stringify(event)}\n`);
  }
  await tagAndPush(options, tag, undefined);
}

const defaultRunner: CommandRunner = async (command, options) => {
  const environment = { ...process.env, ...options.environment };
  if (options.stream) {
    const child = Bun.spawn([...command], {
      cwd: options.cwd,
      env: environment,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    return { exitCode: await child.exited, stdout: '', stderr: '' };
  }
  const child = Bun.spawn([...command], {
    cwd: options.cwd,
    env: environment,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
};

if (import.meta.main) {
  try {
    // packages/weft/scripts/publish-if-missing.ts → packages/weft and the repository root.
    const packageRoot = path.resolve(import.meta.dir, '..');
    const manifest = JSON.parse(
      fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
    ) as { name?: string; version?: string };
    if (!manifest.name || !manifest.version) {
      throw new PublishError('package.json is missing a name or version field.');
    }
    await publishIfMissing({
      packageRoot,
      repositoryRoot: path.resolve(packageRoot, '..', '..'),
      name: manifest.name,
      version: manifest.version,
      run: defaultRunner,
      log: (line) => console.log(line),
      outputFile: process.env['CHANGESETS_OUTPUT'],
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

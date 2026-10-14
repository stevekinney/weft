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

/** The object id on the first line of an `ls-remote` listing, if any. */
function firstObjectId(listing: string): string | undefined {
  return listing.trim().split(/\s+/)[0] || undefined;
}

/**
 * The commit the remote tag resolves to, or `undefined` when there is no such tag.
 *
 * `ls-remote` shows an annotated tag's own object id, not the commit it points at, and a pattern
 * only matches the exact ref, so the peeled `^{}` ref has to be asked for by its full name. A
 * lightweight tag has no peeled ref and its listed id already is the commit.
 */
async function remoteTagTarget(
  options: PublishIfMissingOptions,
  tag: string,
): Promise<string | undefined> {
  const git = { cwd: options.repositoryRoot };
  // A bare pattern matches the tail of any ref, so `releases/v1.0.0` would answer for `v1.0.0`.
  const listing = await expectSuccess(
    options,
    ['git', 'ls-remote', '--tags', 'origin', `refs/tags/${tag}`],
    git,
  );
  const direct = firstObjectId(listing.stdout);
  if (!direct) return undefined;
  const peeled = await expectSuccess(
    options,
    ['git', 'ls-remote', '--tags', 'origin', `refs/tags/${tag}^{}`],
    git,
  );
  return firstObjectId(peeled.stdout) ?? direct;
}

/**
 * Reconcile the remote tag with the commit npm says published the version.
 *
 * A missing tag goes on `gitHead`. An existing tag must already point there: a tag on any other
 * commit is a discrepancy for a person to resolve, so it fails the run and is never moved.
 */
async function reconcileTag(options: PublishIfMissingOptions, tag: string): Promise<void> {
  const existing = await remoteTagTarget(options, tag);
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
 * Whether a changeset releases `name`. The frontmatter is YAML, as Changesets parses it, so a
 * hand-edited file with quoting or comments reads the same. Anything that is not a valid changeset
 * throws: a file that cannot be read must block a publish, never wave it through.
 */
export function changesetReleases(content: string, name: string, file = 'changeset'): boolean {
  // The same frontmatter split @changesets/parse uses.
  const frontmatter = /\s*---([^]*?)\n\s*---(\s*(?:\n|$)[^]*)/.exec(content);
  if (!frontmatter) {
    throw new PublishError(`${file} has no changeset frontmatter, so it cannot be read safely.`);
  }
  let releases: unknown;
  try {
    releases = Bun.YAML.parse(frontmatter[1] ?? '');
  } catch (error) {
    throw new PublishError(
      `${file} has frontmatter that is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (releases === null || releases === undefined) return false;
  if (typeof releases !== 'object' || Array.isArray(releases)) {
    throw new PublishError(`${file} frontmatter is not a map of package names to bump types.`);
  }
  if (!Object.hasOwn(releases, name)) return false;
  const bump = (releases as Record<string, unknown>)[name];
  if (bump === 'major' || bump === 'minor' || bump === 'patch') return true;
  if (bump === 'none') return false;
  throw new PublishError(`${file} gives ${name} an unknown bump type: ${String(bump)}`);
}

/**
 * The changesets still pending at `commit` that release this package. An empty changeset
 * (`changeset --empty`) or one for another package bumps nothing here, so it is not counted.
 */
async function pendingChangesets(
  options: PublishIfMissingOptions,
  commit: string,
): Promise<string[]> {
  const git = { cwd: options.repositoryRoot };
  const listing = await expectSuccess(
    options,
    ['git', 'ls-tree', '--name-only', commit, '--', '.changeset/'],
    git,
  );
  const files = listing.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((file) => file.endsWith('.md') && file !== '.changeset/README.md');
  const releasing: string[] = [];
  for (const file of files) {
    const shown = await expectSuccess(options, ['git', 'show', `${commit}:${file}`], git);
    if (changesetReleases(shown.stdout, options.name, file)) releasing.push(file);
  }
  return releasing;
}

/**
 * Decide whether this commit may publish a version npm does not have.
 *
 * Only the commit that set the version publishes it: the one whose first parent has a different
 * manifest version. A later commit still carries the bumped manifest, and publishing from it would
 * ship later, unversioned code under that version, so it refuses and names the bump commit to
 * re-run. A bump commit that still has pending changesets was a Version Packages pull request
 * merged behind changes it did not version (main does not require branches to be up to date), so
 * that version is abandoned rather than published: the next Version Packages pull request versions
 * those changes too and publishes the version after it. Returns whether to publish.
 */
async function headMayPublish(options: PublishIfMissingOptions): Promise<boolean> {
  const manifestPath = path
    .relative(options.repositoryRoot, path.join(options.packageRoot, 'package.json'))
    .split(path.sep)
    .join('/');
  const git = { cwd: options.repositoryRoot };
  const parent = await expectSuccess(options, ['git', 'show', `HEAD^:${manifestPath}`], git);
  let parentVersion: unknown;
  try {
    parentVersion = (JSON.parse(parent.stdout) as { version?: unknown }).version;
  } catch {
    throw new PublishError(`Could not read the version in HEAD^:${manifestPath}.`);
  }
  const headSetTheVersion = parentVersion !== options.version;

  let bump = 'HEAD';
  if (!headSetTheVersion) {
    const search = await expectSuccess(
      options,
      ['git', 'log', '-1', '--format=%H', `-S"version": "${options.version}"`, '--', manifestPath],
      git,
    );
    bump = search.stdout.trim();
    if (!bump) {
      throw new PublishError(
        `${options.name}@${options.version} is not on npm, but HEAD did not set that version, ` +
          'and history did not show which commit did. Find the commit that bumped it and re-run ' +
          'its release workflow run from the Actions UI; a re-run uses its original commit.',
      );
    }
  }

  const pending = await pendingChangesets(options, bump);
  if (pending.length > 0) {
    const abandoned =
      `${options.name}@${options.version} is not published: the commit that set it ` +
      `(${bump}) still has pending changesets (${pending.join(', ')}), so the Version Packages ` +
      'pull request merged behind changes it did not version. The next Version Packages pull ' +
      'request versions them and publishes the version after this one.';
    if (headSetTheVersion) throw new PublishError(abandoned);
    options.log(`::warning::${abandoned}`);
    return false;
  }

  if (headSetTheVersion) return true;
  throw new PublishError(
    `${options.name}@${options.version} is not on npm, but HEAD did not set that version, so it ` +
      'is not published from here: a later commit would ship under a version it was never ' +
      `bumped for. Re-run the release workflow run for ${bump}, the commit that bumped it, from ` +
      'the Actions UI; a re-run uses its original commit.',
  );
}

/**
 * Refuse to publish when the release tag already exists on another commit.
 *
 * A publish cannot be undone, so the tag it will advertise is checked first: absent, or already
 * on HEAD (a previous attempt tagged it and then failed). Returns whether it is already on HEAD.
 */
async function assertTagFreeOrOnHead(
  options: PublishIfMissingOptions,
  tag: string,
): Promise<boolean> {
  const existing = await remoteTagTarget(options, tag);
  if (!existing) return false;
  const head = await expectSuccess(options, ['git', 'rev-parse', 'HEAD'], {
    cwd: options.repositoryRoot,
  });
  const commit = head.stdout.trim();
  if (existing.toLowerCase() === commit.toLowerCase()) return true;
  throw new PublishError(
    `${tag} already points at ${existing}, not at HEAD (${commit}), so ` +
      `${options.name}@${options.version} is not published: its tag would name the wrong source. ` +
      'Fix the tag by hand, then re-run this release run.',
  );
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

  if (await isPublished(options)) {
    options.log(`${options.name}@${options.version} is already on npm; skipping publish`);
    await reconcileTag(options, tag);
    return;
  }

  if (!(await headMayPublish(options))) return;
  const tagAlreadyOnHead = await assertTagFreeOrOnHead(options, tag);
  await expectSuccess(options, ['bun', 'run', 'scripts/verify-release-version.ts'], packageCommand);
  await expectSuccess(options, ['bun', 'run', 'prepack'], packageCommand);
  // Provenance is requested for the real publish only, as it was before releases moved here.
  await expectSuccess(options, ['npm', 'publish', '--dry-run', '--ignore-scripts'], {
    ...packageCommand,
    environment: { NPM_CONFIG_PROVENANCE: 'false' },
  });
  await expectSuccess(options, ['npm', 'publish', '--ignore-scripts'], packageCommand);
  if (tagAlreadyOnHead) {
    options.log(`${tag} already points at the commit that published; leaving it in place`);
    return;
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
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

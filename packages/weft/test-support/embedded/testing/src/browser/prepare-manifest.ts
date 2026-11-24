import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, relative, resolve, sep } from 'node:path';

import { extractFixtures } from '../fixture-extraction/index.ts';
import type { ComponentEntry } from '../helpers/manifest.ts';
import { assertUniqueFixtureNames } from './manifest.ts';

/**
 * Where a fixture host's manifest inputs live and where its outputs go. Each suite (the root
 * `scripts/browser-fixtures` suite and every package's `browser/` suite) describes its own; tests
 * pass a layout over a temporary tree.
 */
export type ManifestLayout = {
  /** Paths in the input hash are relative to this directory. */
  repositoryRoot: string;
  /** Directories scanned for `*-fixtures.ts` declarations and `*.fixture.svelte` hosts. */
  fixtureRoots: string[];
  /** Source and host module-map keys are relative to this directory. */
  sourceRoot: string;
  /**
   * The directories of application fixtures (`*.svelte`), one file per declared component. A
   * component's file is looked up in each, and a name found in two of them is an error. Their
   * module-map keys are `./fixtures/<file>`, whichever directory holds the file.
   */
  appFixtureRoots: string[];
  /** The application fixtures to add, by component name. */
  appFixtureDeclarations: Readonly<Record<string, readonly string[]>>;
  /**
   * Files that decide the manifest's content without being fixtures: patterns relative to
   * `repositoryRoot`, each of which must match at least one file.
   */
  codeInputs: string[];
  /** Receives `manifest.json`, `fixture-modules.ts`, and `manifest-inputs.sha256`. */
  outputDirectory: string;
};

/** The generated files, and the file that records which inputs they were generated from. */
export function manifestOutputPaths(layout: ManifestLayout): {
  manifest: string;
  moduleMap: string;
  inputHash: string;
} {
  return {
    manifest: resolve(layout.outputDirectory, 'manifest.json'),
    moduleMap: resolve(layout.outputDirectory, 'fixture-modules.ts'),
    inputHash: resolve(layout.outputDirectory, 'manifest-inputs.sha256'),
  };
}

function scanFiles(pattern: string, cwd: string): string[] {
  if (!existsSync(cwd)) return [];
  return Array.from(new Bun.Glob(pattern).scanSync({ cwd, absolute: true }));
}

/** Every file whose content, or whose existence, can change the manifest, sorted. */
export function manifestInputFiles(layout: ManifestLayout): string[] {
  const files = new Set<string>();
  const scan = (pattern: string, cwd: string): number => {
    const matches = scanFiles(pattern, cwd);
    for (const path of matches) files.add(path);
    return matches.length;
  };
  for (const root of layout.fixtureRoots) {
    scan('**/*-fixtures.ts', root);
    scan('**/*.fixture.svelte', root);
  }
  for (const root of layout.appFixtureRoots) scan('*.svelte', root);
  for (const pattern of layout.codeInputs) {
    if (scan(pattern, layout.repositoryRoot) === 0) {
      throw new Error(
        `Manifest input '${pattern}' matches no file under ${layout.repositoryRoot}.`,
      );
    }
  }
  return [...files].toSorted();
}

/** A digest of the paths and contents of `manifestInputFiles`. */
export async function hashManifestInputs(layout: ManifestLayout): Promise<string> {
  const lines = await Promise.all(
    manifestInputFiles(layout).map(async (path) => {
      const contents = createHash('sha256')
        .update(new Uint8Array(await Bun.file(path).arrayBuffer()))
        .digest('hex');
      return `${relative(layout.repositoryRoot, path).split(sep).join('/')}\0${contents}\n`;
    }),
  );
  return createHash('sha256').update(lines.join('')).digest('hex');
}

async function manifestIsCurrent(layout: ManifestLayout, inputHash: string): Promise<boolean> {
  const paths = manifestOutputPaths(layout);
  const recorded = await Bun.file(paths.inputHash)
    .text()
    .catch(() => undefined);
  // A missing or corrupt record never equals a digest, so it falls through to regeneration.
  if (recorded?.trim() !== inputHash) return false;
  // The record vouches for the outputs, so a deleted one must not read as current.
  const present = await Promise.all(
    [paths.manifest, paths.moduleMap].map((path) => Bun.file(path).exists()),
  );
  return present.every(Boolean);
}

/** The application fixture files, by file name, failing on a name two directories both hold. */
function applicationFixtureFiles(layout: ManifestLayout): Map<string, string> {
  const files = new Map<string, string>();
  for (const root of layout.appFixtureRoots) {
    for (const path of scanFiles('*.svelte', root)) {
      const name = basename(path);
      const existing = files.get(name);
      if (existing !== undefined) {
        throw new Error(`Application fixture '${name}' is in both ${existing} and ${path}.`);
      }
      files.set(name, path);
    }
  }
  return files;
}

async function addApplicationFixtures(
  layout: ManifestLayout,
  entries: ComponentEntry[],
  files: Map<string, string>,
): Promise<void> {
  for (const [componentName, fixtureNames] of Object.entries(layout.appFixtureDeclarations)) {
    const fixturePath = files.get(`${componentName}.svelte`);
    if (fixturePath === undefined) {
      throw new Error(
        `Application fixture '${componentName}.svelte' is declared but in none of ${layout.appFixtureRoots.join(', ')}.`,
      );
    }
    const contentHash = createHash('sha256')
      .update(await Bun.file(fixturePath).text())
      .digest('hex');
    const entry = entries.find((candidate) => candidate.slug === componentName);
    const fixtures = fixtureNames.map((name) => ({
      name,
      mode: 'host' as const,
      fixtureContentHash: contentHash,
      category: 'visual-contract' as const,
    }));
    if (entry === undefined) {
      entries.push({
        name: componentName,
        slug: componentName,
        route: `/page/${componentName}`,
        fixtures,
      });
      continue;
    }
    if (entry.fixtures === undefined) entry.fixtures = [];
    for (const fixture of fixtures) {
      if (!entry.fixtures.some((existing) => existing.name === fixture.name)) {
        entry.fixtures.push(fixture);
      }
    }
  }
}

function moduleMapSource(layout: ManifestLayout, files: Map<string, string>): string {
  const moduleMapPath = manifestOutputPaths(layout).moduleMap;
  const moduleImport = (path: string): string => {
    const value = relative(resolve(moduleMapPath, '..'), path).split(sep).join('/');
    return value.startsWith('.') ? value : `./${value}`;
  };
  const line = (key: string, path: string): string =>
    `  ${JSON.stringify(key)}: () => import(${JSON.stringify(moduleImport(path))}),`;
  const sourceKey = (path: string): string => {
    const relativePath = relative(layout.sourceRoot, path).split(sep).join('/');
    return relativePath.startsWith('.') ? relativePath : `./${relativePath}`;
  };
  const sourceEntries = (paths: string[]): string =>
    paths
      .toSorted()
      .map((path) => line(sourceKey(path), path))
      .join('\n');
  const scanRoots = (pattern: string): string[] =>
    layout.fixtureRoots.flatMap((root) => scanFiles(pattern, root));
  const appEntries = [...files]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([name, path]) => line(`./fixtures/${name}`, path))
    .join('\n');
  return [
    '// Generated by prepareManifest (@lostgradient/testing/browser/prepare-manifest).',
    `export const fixtureModules = {\n${sourceEntries(scanRoots('*/*-fixtures.ts'))}\n};`,
    `export const hostModules = {\n${sourceEntries(scanRoots('**/*.fixture.svelte'))}\n};`,
    `export const appHostModules = {\n${appEntries}\n};`,
    `export const appFixtureDeclarations = ${JSON.stringify(layout.appFixtureDeclarations, null, 2)};`,
    '',
  ].join('\n');
}

/**
 * Writes the fixture manifest and module map, unless the hash recorded beside them still matches
 * the inputs and both exist. The record is removed before the outputs are touched and written
 * last, so a run that fails partway never leaves one that vouches for half-written files.
 */
export async function prepareManifest(layout: ManifestLayout): Promise<'current' | 'prepared'> {
  const paths = manifestOutputPaths(layout);
  const inputHash = await hashManifestInputs(layout);
  if (await manifestIsCurrent(layout, inputHash)) {
    process.stdout.write('manifest up to date\n');
    return 'current';
  }
  await rm(paths.inputHash, { force: true });
  const results = await Promise.all(layout.fixtureRoots.map((root) => extractFixtures(root)));
  const violations = results.flatMap((entry) => entry.violations);
  if (violations.length > 0) throw new Error(violations.join('\n'));

  const entries: ComponentEntry[] = results
    .flatMap((entry) => entry.entries)
    .map(({ componentName, fixtures, contentHash }) => ({
      name: componentName,
      slug: componentName,
      route: `/page/${componentName}`,
      fixtures: fixtures.map((fixture) => ({
        name: fixture.name,
        mode: 'host' in fixture ? ('host' as const) : ('direct' as const),
        fixtureContentHash: contentHash,
        ...(fixture.interact !== undefined ? { interact: fixture.interact } : {}),
        ...(fixture.mask !== undefined ? { mask: fixture.mask } : {}),
        category: fixture.category,
      })),
    }));
  const files = applicationFixtureFiles(layout);
  await addApplicationFixtures(layout, entries, files);
  assertUniqueFixtureNames(entries);
  const digest = createHash('sha256').update(JSON.stringify(entries)).digest('hex');

  await mkdir(layout.outputDirectory, { recursive: true });
  await Bun.write(paths.manifest, JSON.stringify({ digest, entries }, null, 2) + '\n');
  await writeFile(paths.moduleMap, moduleMapSource(layout, files));
  await Bun.write(paths.inputHash, `${inputHash}\n`);
  process.stdout.write(`prepared ${entries.length} fixture groups at ${paths.manifest}\n`);
  return 'prepared';
}

import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import { buildBrowser } from '../build-browser.ts';
import { manifestOutputPaths, prepareManifest, type ManifestLayout } from './prepare-manifest.ts';

export type FixtureBuild = {
  /** The suite's manifest layout; its manifest is prepared first and copied beside the bundle. */
  layout: ManifestLayout;
  /** The page the bundle starts from. */
  indexHtml: string;
  /** Where the bundle goes. */
  outputDirectory: string;
};

/**
 * Prepares the suite's manifest and bundles its fixture page. A development build keeps the hashed
 * assets of an earlier build, so a page loaded before a rebuild can still finish loading.
 */
export async function buildFixtures(build: FixtureBuild, development = false): Promise<void> {
  await prepareManifest(build.layout);
  if (!development) await rm(build.outputDirectory, { recursive: true, force: true });
  await mkdir(build.outputDirectory, { recursive: true });
  await buildBrowser({
    entrypoints: [build.indexHtml],
    outdir: build.outputDirectory,
    development,
  });
  const copy = resolve(build.outputDirectory, '.playwright', 'manifest.json');
  await mkdir(resolve(copy, '..'), { recursive: true });
  await Bun.write(copy, Bun.file(manifestOutputPaths(build.layout).manifest));
}

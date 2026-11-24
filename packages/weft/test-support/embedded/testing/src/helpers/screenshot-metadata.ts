import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { FixtureCategory, InteractionStep, MaskRule } from '../visual-fixtures.ts';
import { screenshotMetadataPath, screenshotPath, type ArtifactKey } from './artifact-path.ts';
import type { Theme, ViewportName } from './manifest.ts';

/** Metadata written beside one captured screenshot. */
export type ScreenshotMetadata = {
  /** Component slug. */
  slug: string;
  /** Component name. */
  component: string;
  /** Fixture name. */
  fixture: string;
  /** Fixture category. */
  category: FixtureCategory;
  /** Color theme. */
  theme: Theme;
  /** Viewport name. */
  viewport: ViewportName;
  /** Route used to render the fixture. */
  route: string;
  /** Fixture source content hash, or `null` when unavailable. */
  fixtureContentHash: string | null;
  /** Interaction steps used to reach the screenshot. */
  interact: InteractionStep[];
  /** Mask rules applied to the screenshot. */
  mask: MaskRule[];
  /** Absolute screenshot path. */
  screenshotPath: string;
};

/** Input used to build screenshot metadata. */
export type ScreenshotMetadataInput = {
  /** Artifact coordinates. */
  key: ArtifactKey;
  /** Component name. */
  component: string;
  /** Fixture category. */
  category: FixtureCategory;
  /** Route used to render the fixture. */
  route: string;
  /** Fixture source content hash. */
  fixtureContentHash?: string | undefined;
  /** Interaction steps used to reach the screenshot. */
  interact?: readonly InteractionStep[] | undefined;
  /** Mask rules applied to the screenshot. */
  mask?: readonly MaskRule[] | undefined;
};

/** Builds the metadata record for a screenshot artifact. */
export function buildScreenshotMetadata(input: ScreenshotMetadataInput): ScreenshotMetadata {
  return {
    slug: input.key.slug,
    component: input.component,
    fixture: input.key.fixture,
    category: input.category,
    theme: input.key.theme,
    viewport: input.key.viewport,
    route: input.route,
    fixtureContentHash: input.fixtureContentHash ?? null,
    interact: [...(input.interact ?? [])],
    mask: [...(input.mask ?? [])],
    screenshotPath: screenshotPath(input.key),
  };
}

/** Writes screenshot metadata beside its screenshot artifact. */
export async function writeScreenshotMetadata(input: ScreenshotMetadataInput): Promise<void> {
  const outputPath = screenshotMetadataPath(input.key);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(buildScreenshotMetadata(input), null, 2) + '\n');
}

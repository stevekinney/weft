import type { Page } from '@playwright/test';
import { loadManifest } from '../index.ts';

const manifest = loadManifest();

export function fixtureRoute(
  slug: string,
  options: { fixtureName?: string; snapshot?: boolean } = {},
): string {
  const entry = manifest.find((candidate) => candidate.slug === slug);
  const fixtureName = options.fixtureName ?? 'assertion';
  const hash = entry?.fixtures?.find((fixture) => fixture.name === fixtureName)?.fixtureContentHash;
  if (hash === undefined) throw new Error(`Assertion fixture hash missing for ${slug}.`);
  const parameters = new URLSearchParams({ fixture: fixtureName, fixtureContentHash: hash });
  if (options.snapshot !== false) parameters.set('snapshot', '1');
  return `/page/${slug}?${parameters.toString()}`;
}

export async function openFixture(
  page: Page,
  slug: string,
  options: { fixtureName?: string; snapshot?: boolean } = {},
): Promise<void> {
  await page.goto(fixtureRoute(slug, options), { waitUntil: 'load' });
}

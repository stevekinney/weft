import type { ComponentEntry } from '../index.ts';
import { loadManifest } from '../index.ts';

export function fixtureEntry(slug: string): ComponentEntry {
  const entry = loadManifest().find((candidate) => candidate.slug === slug);
  if (entry === undefined) throw new Error(`Missing fixture entry for ${slug}`);
  return entry;
}

export function fixtureRoute(slug: string): string {
  const entry = fixtureEntry(slug);
  const fixture = entry.fixtures?.find((candidate) => candidate.name === 'assertion');
  if (fixture === undefined) throw new Error(`Missing assertion fixture for ${slug}`);
  const query = new URLSearchParams({
    snapshot: '1',
    fixture: 'assertion',
    fixtureContentHash: fixture.fixtureContentHash,
  });
  return `${entry.route}?${query.toString()}`;
}

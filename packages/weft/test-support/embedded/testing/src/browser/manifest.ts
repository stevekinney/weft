import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { ComponentEntry, ManifestFixtureEntry } from '../helpers/manifest.ts';
import {
  FIXTURE_CATEGORIES,
  InteractionStepSchema,
  MaskRuleSchema,
  type FixtureCategory,
} from '../visual-fixtures.ts';

export type FixtureManifest = { digest: string; entries: ComponentEntry[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isFixtureCategory(value: unknown): value is FixtureCategory {
  return typeof value === 'string' && FIXTURE_CATEGORIES.some((category) => category === value);
}

function isInteractionSteps(value: unknown): boolean {
  return (
    Array.isArray(value) && value.every((step) => InteractionStepSchema.safeParse(step).success)
  );
}

function isMaskRules(value: unknown): boolean {
  return Array.isArray(value) && value.every((rule) => MaskRuleSchema.safeParse(rule).success);
}

function isOptionalArray(
  value: Record<string, unknown>,
  key: string,
  predicate: (value: unknown) => boolean,
): boolean {
  return value[key] === undefined || predicate(value[key]);
}

function isManifestFixtureEntry(value: unknown): value is ManifestFixtureEntry {
  if (!isRecord(value)) return false;
  return (
    typeof value['name'] === 'string' &&
    (value['mode'] === 'direct' || value['mode'] === 'host') &&
    isHash(value['fixtureContentHash']) &&
    isFixtureCategory(value['category']) &&
    isOptionalArray(value, 'interact', isInteractionSteps) &&
    isOptionalArray(value, 'mask', isMaskRules)
  );
}

function isComponentEntry(value: unknown): value is ComponentEntry {
  if (!isRecord(value)) return false;
  if (
    typeof value['name'] !== 'string' ||
    typeof value['slug'] !== 'string' ||
    typeof value['route'] !== 'string'
  ) {
    return false;
  }
  return (
    value['fixtures'] === undefined ||
    (Array.isArray(value['fixtures']) && value['fixtures'].every(isManifestFixtureEntry))
  );
}

/** Reads and checks the manifest a fixture host's `prepareManifest` wrote at `path`. */
export function readManifest(path: string): FixtureManifest {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('digest' in parsed) ||
    typeof parsed.digest !== 'string' ||
    !('entries' in parsed) ||
    !Array.isArray(parsed.entries) ||
    !parsed.entries.every(isComponentEntry)
  ) {
    throw new Error(`Fixture manifest at ${path} has an invalid shape.`);
  }
  if (!isHash(parsed.digest)) throw new Error(`Fixture manifest at ${path} has an invalid digest.`);
  return { digest: parsed.digest, entries: parsed.entries };
}

export function manifestDigest(entries: ComponentEntry[]): string {
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

export function assertUniqueFixtureNames(entries: ComponentEntry[]): void {
  for (const entry of entries) {
    const names = new Set<string>();
    for (const fixture of entry.fixtures ?? []) {
      if (names.has(fixture.name)) {
        throw new Error(`Duplicate fixture '${entry.slug}/${fixture.name}'.`);
      }
      names.add(fixture.name);
    }
  }
}

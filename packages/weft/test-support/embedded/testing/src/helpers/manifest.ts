import { readFileSync } from 'node:fs';
import { environmentConfiguration } from '../environment-configuration.ts';
import type { FixtureCategory, InteractionStep, MaskRule } from '../visual-fixtures.ts';

/** Supported browser color themes. */
export type Theme = 'light' | 'dark';
/** Supported browser viewport names. */
export type ViewportName = 'mobile' | 'tablet' | 'desktop';
/** Dimensions associated with a viewport name. */
export type Viewport = {
  /** Viewport name. */
  name: ViewportName;
  /** Width in CSS pixels. */
  width: number;
  /** Height in CSS pixels. */
  height: number;
};

/** One fixture entry in the generated manifest. */
export type ManifestFixtureEntry = {
  /** Fixture name. */
  name: string;
  /** Whether rendering is direct or host-backed. */
  mode: 'direct' | 'host';
  /** Hash of the fixture source content. */
  fixtureContentHash: string;
  /** Declared interaction steps. */
  interact?: InteractionStep[];
  /** Declared screenshot masks. */
  mask?: MaskRule[];
  /** Fixture category. */
  category: FixtureCategory;
};

/**
 * A single component entry from the manifest. The `fixtures` field is optional:
 * when omitted, the test loop synthesises a single `{ name: 'default' }` fixture
 * so that every component is exercised at least once.
 *
 * When `fixtures` is present and non-empty, the loop iterates over the explicit
 * list instead of the synthesised default.
 */
export type ComponentEntry = {
  /** Component display name. */
  name: string;
  /** Component slug. */
  slug: string;
  /** Component route. */
  route: string;
  /** Explicit fixture list for components with multiple visual states. When absent, a single `'default'` fixture is used. */
  fixtures?: ManifestFixtureEntry[];
};

/** All themes included in the standard manifest matrix. */
export const THEMES: readonly Theme[] = ['light', 'dark'] as const;
/** All viewports included in the standard manifest matrix. */
export const VIEWPORTS: readonly Viewport[] = [
  { name: 'mobile', width: 375, height: 900 },
  { name: 'tablet', width: 768, height: 900 },
  { name: 'desktop', width: 1280, height: 900 },
] as const;

type ManifestFile = { digest: string; entries: ComponentEntry[] };

const cached = new Map<string, ManifestFile>();

function isManifestFile(value: unknown): value is ManifestFile {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { digest?: unknown }).digest === 'string' &&
    Array.isArray((value as { entries?: unknown }).entries)
  );
}

function manifestPath(path: string | undefined): string {
  if (path === undefined || path.length === 0) {
    throw new Error(
      'A browser fixture manifest path is required. Set BROWSER_FIXTURE_MANIFEST before loading the manifest.',
    );
  }
  return path;
}

function read(
  path = manifestPath(environmentConfiguration().browserFixtureManifest),
): ManifestFile {
  const ownedPath = manifestPath(path);
  const existing = cached.get(ownedPath);
  if (existing !== undefined) return existing;
  let raw: string;
  try {
    raw = readFileSync(ownedPath, 'utf-8');
  } catch (error) {
    throw new Error(
      `Browser fixture manifest missing at ${ownedPath}. Run the owning application's manifest preparation command before loading this module.`,
      { cause: error },
    );
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isManifestFile(parsed)) {
    throw new Error(`Manifest cache at ${path} does not match the expected shape.`);
  }
  cached.set(ownedPath, parsed);
  return parsed;
}

/** Loads and validates the generated browser fixture manifest. */
export function loadManifest(path?: string): ComponentEntry[] {
  return read(path).entries;
}

/** Returns the digest recorded in the generated browser fixture manifest. */
export function manifestDigest(path?: string): string {
  return read(path).digest;
}

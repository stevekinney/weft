import type { ComponentEntry, ManifestFixtureEntry } from '../index.ts';

export type FixtureRequest = {
  entry: ComponentEntry;
  fixture: ManifestFixtureEntry;
};

export type RouteError = { status: number; message: string };

export function resolveFixtureRequest(
  entries: readonly ComponentEntry[],
  component: string,
  fixtureName: string | null,
  fixtureContentHash: string | null,
): FixtureRequest | RouteError {
  const entry = entries.find((candidate) => candidate.slug === component);
  if (entry === undefined)
    return { status: 404, message: `Unknown fixture component '${component}'.` };
  const fixture = entry.fixtures?.find(
    (candidate) => candidate.name === (fixtureName ?? entry.fixtures?.[0]?.name),
  );
  if (fixture === undefined)
    return { status: 404, message: `Unknown fixture '${component}/${fixtureName}'.` };
  if (fixtureName !== null && fixtureContentHash === null) {
    return {
      status: 400,
      message: `Fixture '${component}/${fixtureName}' requires fixtureContentHash.`,
    };
  }
  if (fixtureContentHash !== null && fixtureContentHash !== fixture.fixtureContentHash) {
    return {
      status: 409,
      message: `Fixture content hash drift for '${component}/${fixture.name}'. Expected ${fixture.fixtureContentHash}.`,
    };
  }
  return { entry, fixture };
}

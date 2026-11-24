import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { createOperationClientSources } from './generate-operation-client.ts';
import { fixtureOptions, fixtureSnapshot } from './operation-client-test-support.ts';

/**
 * Where the generated client of the fixture catalog is checked in. A type test imports it to
 * assert that each subscription's event type is its `eventSchema`, which only generated output can
 * show. The files are the generator's exact text, formatted by nothing, so a test can compare them
 * byte for byte, and `.prettierignore` leaves them alone.
 */
export const FIXTURE_CLIENT_DIRECTORY = join(
  import.meta.dir,
  '..',
  'src',
  '__fixtures__',
  'probe-client',
);

/** The fixture client the generator produces now: subscriptions on, the other host's left out. */
export function fixtureClientSources(): Promise<ReadonlyMap<string, string>> {
  return createOperationClientSources(
    fixtureSnapshot(),
    fixtureOptions({
      outputDirectory: 'src/__fixtures__/probe-client',
      runtimeSpecifier: '../../client/index.ts',
      subscriptions: 'generic',
      subscriptionRoutes: { include: (operation) => !operation.name.startsWith('other.') },
    }),
  );
}

/** Writes the fixture client, replacing what is checked in. */
export async function writeFixtureClient(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  for (const [fileName, source] of await fixtureClientSources()) {
    await Bun.write(join(directory, fileName), source);
  }
}

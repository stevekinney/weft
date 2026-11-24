/**
 * Rewrites the generated client of the fixture catalog, `src/__fixtures__/probe-client/`. Run it
 * from `packages/backchannel` after a change that legitimately alters what the generator emits,
 * and commit the result.
 */

import { FIXTURE_CLIENT_DIRECTORY, writeFixtureClient } from './operation-client-fixture.ts';

await writeFixtureClient(FIXTURE_CLIENT_DIRECTORY);

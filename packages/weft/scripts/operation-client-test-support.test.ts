/**
 * COR-1283: `snapshotTestOperation`'s `invoke: async () => null` handler.
 * Its one existing consumer (generate-operation-client.test.ts) only ever
 * constructs operations with this fixture to inspect the generated client
 * source text and catalog snapshot shape — it never actually invokes the
 * resulting operation. This proves the fixture's invoke handler does what
 * its trivial implementation promises.
 */
import { describe, expect, it } from 'bun:test';

import { anonymousPrincipal } from '../src/server/principal.ts';
import { snapshotTestOperation } from './operation-client-test-support.ts';

describe('snapshotTestOperation', () => {
  it('its invoke handler resolves null', async () => {
    const operation = snapshotTestOperation('weft.test.invokesupport', { kind: 'public' });

    await expect(
      operation.invoke({
        input: {},
        principal: anonymousPrincipal(),
        engine: undefined,
        transport: 'http-rest',
      }),
    ).resolves.toBeNull();
  });
});

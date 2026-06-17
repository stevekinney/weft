import { describe, expect, it } from 'bun:test';

import { anonymousPrincipal } from '../principal.ts';
import { fleetEventsSubscriptionOperation } from './fleet-events-subscription.ts';

describe('weft.events.subscribe operation', () => {
  it('rejects an invalid cursor if invoke receives unvalidated input', async () => {
    const fleetFeed = {
      async snapshotTailSequence() {
        throw new Error('snapshotTailSequence should not run for an invalid cursor');
      },
      subscribe() {
        throw new Error('subscribe should not run for an invalid cursor');
      },
    };

    await expect(
      fleetEventsSubscriptionOperation.invoke({
        input: { fromCursor: 'not-a-cursor' },
        principal: anonymousPrincipal(),
        engine: { fleetFeed },
        transport: 'jsonRpcWebSocket',
      }),
    ).rejects.toMatchObject({
      code: 'InvalidParams',
      message: 'Invalid cursor',
    });
  });
});

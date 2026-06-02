import { TestEngine } from '@lostgradient/weft/testing';
import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CheckoutInput } from '../src/index';
import {
  calculateTotalCents,
  checkoutWorkflow,
  createCheckoutInput,
  runCheckoutExample,
  sampleCheckoutInput,
} from '../src/index';

function expectedCheckoutResult(input: CheckoutInput) {
  return {
    confirmationId: `conf_${input.orderId}`,
    orderId: input.orderId,
    paymentId: `pay_${input.orderId}`,
    reservationId: `res_${input.orderId}`,
    status: 'scheduled-for-shipment',
    totalCents: calculateTotalCents(input.items),
    trackingNumber: `trk_${input.orderId}`,
  } as const;
}

describe('checkout example', () => {
  it('charges, reserves, confirms, and schedules shipping', async () => {
    await using engine = new TestEngine().register(checkoutWorkflow);

    const handle = await engine.start('checkout', sampleCheckoutInput, {
      id: sampleCheckoutInput.orderId,
    });

    await expect(handle.result()).resolves.toEqual(expectedCheckoutResult(sampleCheckoutInput));
  });

  it('runs through the packaged SQLite consumer path', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'weft-checkout-'));
    const databasePath = join(temporaryDirectory, 'checkout.sqlite');
    const input = createCheckoutInput('checkout-smoke');

    try {
      await expect(runCheckoutExample(input, databasePath)).resolves.toEqual(
        expectedCheckoutResult(input),
      );
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });
});

import { activity } from '@lostgradient/weft';

import type { CancelStaleOrderInput, ShipmentInput, ShipmentResult } from '../model';

export const shipOrder = activity({
  name: 'orderProcessingShipOrder',
  idempotent: true,
  timeout: '20s',
  retry: {
    backoffMultiplier: 2,
    initialBackoff: '500ms',
    maxAttempts: 3,
    maxBackoff: '10s',
  },
  execute: async (input: ShipmentInput): Promise<ShipmentResult> => {
    return {
      carrier: 'GroundShip',
      orderId: input.orderId,
      trackingNumber: `trk_${input.orderId}_${input.reservationIds.length}`,
    };
  },
});

export const cancelStaleOrder = activity({
  name: 'orderProcessingCancelStaleOrder',
  idempotent: true,
  timeout: '10s',
  retry: {
    backoffMultiplier: 2,
    initialBackoff: '100ms',
    maxAttempts: 3,
    maxBackoff: '2s',
  },
  execute: async (input: CancelStaleOrderInput): Promise<string> => {
    return input.orderId;
  },
});

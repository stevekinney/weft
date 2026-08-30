import { activity } from '@lostgradient/weft';

import type {
  InventoryReservation,
  InventoryReservationInput,
  ReleaseInventoryInput,
} from '../model';

export const reserveInventory = activity({
  name: 'orderProcessingReserveInventory',
  idempotent: true,
  timeout: '10s',
  retry: {
    backoffMultiplier: 2,
    initialBackoff: '100ms',
    maxAttempts: 3,
    maxBackoff: '2s',
  },
  execute: async (input: InventoryReservationInput): Promise<InventoryReservation> => {
    return {
      reservationId: `res_${input.orderId}_${input.warehouseId}`,
      skuCount: input.items.length,
      warehouseId: input.warehouseId,
    };
  },
});

export const releaseInventory = activity({
  name: 'orderProcessingReleaseInventory',
  idempotent: true,
  timeout: '10s',
  retry: {
    backoffMultiplier: 2,
    initialBackoff: '100ms',
    maxAttempts: 3,
    maxBackoff: '2s',
  },
  execute: async (input: ReleaseInventoryInput): Promise<string[]> => {
    return input.reservationIds;
  },
});

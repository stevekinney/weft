import { workflow } from '@lostgradient/weft';

import { cancelStaleOrder } from '../activities/shipping';
import type { SweepStaleOrdersInput } from '../model';

export const sweepStaleOrdersWorkflow = workflow({ name: 'orderProcessingSweepStaleOrders' })
  .activities({ orderProcessingCancelStaleOrder: cancelStaleOrder })
  .execute(async function* orderProcessingSweepStaleOrders(context, input: SweepStaleOrdersInput) {
    yield* context.memo(`sweep:${input.now}`, () => input.staleOrderIds.length);
    const cancelledOrderIds = yield* context.all(
      input.staleOrderIds.map((orderId) =>
        context.run(cancelStaleOrder, {
          orderId,
          reason: 'stale-order-sweep',
        }),
      ),
    );
    return {
      cancelledOrderIds,
      scannedOrderCount: input.staleOrderIds.length,
    };
  });

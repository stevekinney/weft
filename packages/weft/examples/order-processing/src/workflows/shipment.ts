import { workflow } from '@lostgradient/weft';

import { shipOrder } from '../activities/shipping';
import type { ShipmentInput } from '../model';

export const shipmentWorkflow = workflow({ name: 'orderProcessingShipment' })
  .activities({ orderProcessingShipOrder: shipOrder })
  .execute(async function* orderProcessingShipment(context, input: ShipmentInput) {
    return yield* context.run(shipOrder, input);
  });

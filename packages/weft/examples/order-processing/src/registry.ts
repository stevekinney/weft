import { Engine, schedule } from '@lostgradient/weft';

import { staleOrderSweepInput } from './sample-data';
import { orderWorkflow } from './workflows/order';
import { shipmentWorkflow } from './workflows/shipment';
import { sweepStaleOrdersWorkflow } from './workflows/sweep-stale';

export const orderProcessingSchedule = schedule({
  cron: '0 * * * *',
  id: 'order-processing-stale-order-sweep',
  input: staleOrderSweepInput,
  overlapPolicy: 'skip',
  workflow: sweepStaleOrdersWorkflow,
});

export function createOrderProcessingEngine<TEngine extends Engine>(engine: TEngine): TEngine {
  engine.register(orderWorkflow);
  engine.register(shipmentWorkflow);
  engine.register(sweepStaleOrdersWorkflow);
  return engine;
}

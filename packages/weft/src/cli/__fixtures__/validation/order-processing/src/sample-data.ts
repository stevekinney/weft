import type { OrderProcessingInput, SweepStaleOrdersInput } from './model';

export const standardOrderInput: OrderProcessingInput = {
  customerEmail: 'ada@example.com',
  customerId: 'cust_ada',
  items: [
    { quantity: 1, sku: 'keyboard', unitPrice: 149, warehouseId: 'denver' },
    { quantity: 2, sku: 'notebook', unitPrice: 18, warehouseId: 'seattle' },
  ],
  orderId: 'order_standard',
  placedAt: '2026-05-14T05:00:00.000Z',
};

export const highValueOrderInput: OrderProcessingInput = {
  customerEmail: 'grace@example.com',
  customerId: 'cust_grace',
  itemUpdateWindowMs: 1_000,
  items: [
    { quantity: 2, sku: 'laptop', unitPrice: 1_199, warehouseId: 'denver' },
    { quantity: 1, sku: 'dock', unitPrice: 239, warehouseId: 'atlanta' },
  ],
  orderId: 'order_high_value',
  placedAt: '2026-05-14T05:05:00.000Z',
};

export const staleOrderSweepInput: SweepStaleOrdersInput = {
  now: '2026-05-15T05:00:00.000Z',
  staleOrderIds: ['order_stale'],
};

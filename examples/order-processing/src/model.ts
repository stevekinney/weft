import type { SearchAttributeValue } from '@lostgradient/weft';

export const highValueReviewThreshold = 1_000;

export type WarehouseId = 'denver' | 'seattle' | 'atlanta';

export interface OrderItem {
  sku: string;
  quantity: number;
  unitPrice: number;
  warehouseId: WarehouseId;
}

export interface OrderProcessingInput {
  allowCancellationBeforeShipment?: boolean;
  customerId: string;
  customerEmail: string;
  itemUpdateWindowMs?: number;
  items: OrderItem[];
  orderId: string;
  placedAt: string;
}

export interface AddItemInput extends OrderItem {}

export type AddItemResult =
  | {
      accepted: true;
      itemCount: number;
      totalAmount: number;
    }
  | {
      accepted: false;
      reason: string;
      status: OrderStatusName;
    };

export interface OrderStatus {
  itemCount: number;
  orderId: string;
  status: OrderStatusName;
  totalAmount: number;
}

export type OrderStatusName =
  | 'received'
  | 'reserving'
  | 'awaiting-review'
  | 'awaiting-shipment'
  | 'cancelled'
  | 'shipped';

export interface CancelOrderInput {
  reason: string;
}

export interface InventoryReservationInput {
  items: OrderItem[];
  orderId: string;
  warehouseId: WarehouseId;
}

export interface InventoryReservation {
  reservationId: string;
  warehouseId: WarehouseId;
  skuCount: number;
}

export interface ReleaseInventoryInput {
  orderId: string;
  reservationIds: string[];
}

export interface ChargePaymentInput {
  amount: number;
  customerId: string;
  idempotencyKey: string;
  orderId: string;
}

export interface PaymentCharge {
  amount: number;
  chargeId: string;
}

export interface RefundPaymentInput {
  amount: number;
  chargeId: string;
  orderId: string;
}

export interface ShipmentInput {
  customerEmail: string;
  orderId: string;
  reservationIds: string[];
}

export interface ShipmentResult {
  carrier: 'GroundShip';
  orderId: string;
  trackingNumber: string;
}

export interface CancelStaleOrderInput {
  orderId: string;
  reason: string;
}

export type OrderCompletion = CancelledOrderCompletion | ShippedOrderCompletion;

export interface CancelledOrderCompletion {
  orderId: string;
  refundId: string;
  releasedReservationIds: string[];
  status: 'cancelled';
}

export interface ShippedOrderCompletion {
  chargeId: string;
  orderId: string;
  status: 'shipped';
  trackingNumber: string;
}

export interface SweepStaleOrdersInput {
  now: string;
  staleOrderIds: string[];
}

export interface SweepStaleOrdersResult {
  cancelledOrderIds: string[];
  scannedOrderCount: number;
}

export function calculateOrderTotal(items: readonly OrderItem[]): number {
  return items.reduce((total, item) => total + item.quantity * item.unitPrice, 0);
}

export function groupItemsByWarehouse(
  items: readonly OrderItem[],
): Array<[WarehouseId, OrderItem[]]> {
  const groups = new Map<WarehouseId, OrderItem[]>();
  for (const item of items) {
    const warehouseItems = groups.get(item.warehouseId) ?? [];
    warehouseItems.push(item);
    groups.set(item.warehouseId, warehouseItems);
  }
  return [...groups.entries()];
}

export function orderAttributes(
  input: Pick<OrderProcessingInput, 'customerId'> & { totalAmount: number },
  status: OrderStatusName,
): Record<string, SearchAttributeValue> {
  return {
    customerId: input.customerId,
    orderStatus: status,
    totalAmount: input.totalAmount,
  };
}

import { searchAttribute, workflow, type WorkflowContext } from '@lostgradient/weft';

import { releaseInventory, reserveInventory } from '../activities/inventory';
import { chargePayment, refundPayment } from '../activities/payment';
import { addItemUpdate, cancelOrderSignal, orderStatusQuery } from '../messages';
import {
  calculateOrderTotal,
  groupItemsByWarehouse,
  highValueReviewThreshold,
  orderAttributes,
  type AddItemInput,
  type AddItemResult,
  type ChargePaymentInput,
  type OrderCompletion,
  type OrderProcessingInput,
  type OrderStatus,
  type OrderStatusName,
  type ShipmentResult,
} from '../model';

export const customerIdAttribute = searchAttribute('customerId', 'string');
export const orderStatusAttribute = searchAttribute('orderStatus', 'string');
export const totalAmountAttribute = searchAttribute('totalAmount', 'number');

export const orderWorkflow = workflow({ name: 'orderProcessingOrder' })
  .activities({
    orderProcessingReserveInventory: reserveInventory,
    orderProcessingReleaseInventory: releaseInventory,
    orderProcessingChargePayment: chargePayment,
    orderProcessingRefundPayment: refundPayment,
  })
  .searchAttributes({
    customerId: { type: 'string' },
    orderStatus: { type: 'string' },
    totalAmount: { type: 'number' },
  })
  .execute(async function* orderProcessingOrder(context, input: OrderProcessingInput) {
    let items = [...input.items];
    let status: OrderStatusName = 'received';
    let totalAmount = calculateOrderTotal(items);
    let updatesOpen = true;

    const setStatus = (nextStatus: OrderStatusName) => {
      status = nextStatus;
      context.setAttributes(orderAttributes({ ...input, totalAmount }, status));
    };
    const currentStatus = (): OrderStatus => ({
      itemCount: items.length,
      orderId: input.orderId,
      status,
      totalAmount,
    });

    context.onQuery(orderStatusQuery, currentStatus);
    context.onUpdate(addItemUpdate, addItemBeforeReservation);
    if (input.itemUpdateWindowMs !== undefined) {
      yield* context.sleep(input.itemUpdateWindowMs);
    }

    context.setAttribute(customerIdAttribute, input.customerId);
    updatesOpen = false;
    setStatus('reserving');
    const reservations = yield* context.all(
      groupItemsByWarehouse(items).map(([warehouseId, warehouseItems]) =>
        context.run(reserveInventory, {
          items: warehouseItems,
          orderId: input.orderId,
          warehouseId,
        }),
      ),
    );
    const reservationIds = reservations.map((reservation) => reservation.reservationId);

    const chargeInput: ChargePaymentInput = {
      amount: totalAmount,
      customerId: input.customerId,
      idempotencyKey: input.orderId,
      orderId: input.orderId,
    };
    const charge = yield* context.run(chargePayment, chargeInput);

    if (totalAmount >= highValueReviewThreshold) {
      setStatus('awaiting-review');
      const decision = yield* context.review({
        artifact: {
          chargeId: charge.chargeId,
          customerId: input.customerId,
          items,
          orderId: input.orderId,
          totalAmount,
        },
        reviewType: 'high-value-order',
        timeout: 24 * 60 * 60 * 1000,
      });

      if (decision.decision !== 'approved') {
        return yield* compensateCancelledOrder(context, input.orderId, charge, reservationIds);
      }
    }

    setStatus('awaiting-shipment');
    if (input.allowCancellationBeforeShipment === true) {
      yield* context.waitForSignal(cancelOrderSignal);
      return yield* compensateCancelledOrder(context, input.orderId, charge, reservationIds);
    }

    const shipment = yield* context.startChild<ShipmentResult>('orderProcessingShipment', {
      customerEmail: input.customerEmail,
      orderId: input.orderId,
      reservationIds,
    });

    setStatus('shipped');
    yield* context.memo('shipped-status-indexed', () => true);
    return {
      chargeId: charge.chargeId,
      orderId: input.orderId,
      status: 'shipped',
      trackingNumber: shipment.trackingNumber,
    };

    function addItemBeforeReservation(item: AddItemInput): AddItemResult {
      if (!updatesOpen) {
        return {
          accepted: false,
          reason: 'Orders can only be changed before inventory reservation starts.',
          status,
        };
      }

      items = [...items, item];
      totalAmount = calculateOrderTotal(items);
      context.setAttribute(totalAmountAttribute, totalAmount);
      return {
        accepted: true,
        itemCount: items.length,
        totalAmount,
      };
    }
  });

function* compensateCancelledOrder(
  context: WorkflowContext,
  orderId: string,
  charge: { amount: number; chargeId: string },
  reservationIds: string[],
): Generator<unknown, OrderCompletion, unknown> {
  context.setAttribute(orderStatusAttribute, 'cancelled');
  const [releasedReservationIds, refundId] = yield* context.all([
    context.run(releaseInventory, { orderId, reservationIds }),
    context.run(refundPayment, {
      amount: charge.amount,
      chargeId: charge.chargeId,
      orderId,
    }),
  ]);

  return {
    orderId,
    refundId,
    releasedReservationIds,
    status: 'cancelled',
  };
}

import { TestEngine } from '@lostgradient/weft/testing';
import { describe, expect, it } from 'bun:test';

import { addItemUpdate, cancelOrderSignal, orderStatusQuery } from '../src/messages';
import { calculateOrderTotal, type AddItemInput } from '../src/model';
import { createOrderProcessingEngine, orderProcessingSchedule } from '../src/registry';
import { highValueOrderInput, standardOrderInput } from '../src/sample-data';

describe('order-processing reference example', () => {
  it('runs the happy path across activities, updates, queries, review, child workflow, and search attributes', async () => {
    await using engine = createOrderProcessingEngine(new TestEngine());

    const handle = await engine.start('orderProcessingOrder', highValueOrderInput, {
      id: highValueOrderInput.orderId,
      searchAttributes: {
        customerId: highValueOrderInput.customerId,
        orderStatus: 'received',
        totalAmount: calculateOrderTotal(highValueOrderInput.items),
      },
    });

    const giftWrapItem: AddItemInput = {
      sku: 'gift-wrap',
      quantity: 1,
      warehouseId: 'denver',
      unitPrice: 5,
    };
    const updateResult = await handle.update(addItemUpdate, giftWrapItem);
    expect(updateResult).toEqual({
      accepted: true,
      itemCount: highValueOrderInput.items.length + 1,
      totalAmount: calculateOrderTotal(highValueOrderInput.items) + 5,
    });
    await engine.advanceTime(highValueOrderInput.itemUpdateWindowMs!);

    await expect(handle.query(orderStatusQuery)).resolves.toEqual({
      itemCount: highValueOrderInput.items.length + 1,
      orderId: highValueOrderInput.orderId,
      status: 'awaiting-review',
      totalAmount: calculateOrderTotal(highValueOrderInput.items) + 5,
    });
    const pendingReviews = await engine.listReviews({ workflowId: highValueOrderInput.orderId });
    expect(pendingReviews).toHaveLength(1);
    expect(pendingReviews[0]).toMatchObject({
      reviewType: 'high-value-order',
      status: 'pending',
    });
    const awaitingReviewOrders = await engine.list({
      attributes: [{ key: 'orderStatus', value: 'awaiting-review' }],
    });
    expect(awaitingReviewOrders.items.map((workflow) => workflow.id)).toContain(
      highValueOrderInput.orderId,
    );

    await engine.submitReview(pendingReviews[0]!.reviewId, {
      decision: 'approved',
      reviewer: 'operations@example.com',
    });
    await expect(handle.result()).resolves.toMatchObject({
      orderId: highValueOrderInput.orderId,
      status: 'shipped',
      trackingNumber: expect.stringContaining('trk_'),
    });

    const allWorkflows = await engine.list();
    expect(allWorkflows.items.map((workflow) => workflow.id)).toContain(
      highValueOrderInput.orderId,
    );
    expect(allWorkflows.items).toContainEqual(
      expect.objectContaining({
        status: 'completed',
        type: 'orderProcessingShipment',
      }),
    );
  });

  it('compensates inventory and payment when a high-value review is rejected', async () => {
    await using engine = createOrderProcessingEngine(new TestEngine());
    const rejectedOrderInput = {
      ...highValueOrderInput,
      orderId: 'order_high_value_rejected',
    };

    const handle = await engine.start('orderProcessingOrder', rejectedOrderInput, {
      id: rejectedOrderInput.orderId,
    });

    await engine.advanceTime(rejectedOrderInput.itemUpdateWindowMs!);
    const pendingReviews = await engine.listReviews({ workflowId: rejectedOrderInput.orderId });
    expect(pendingReviews).toHaveLength(1);

    await engine.submitReview(pendingReviews[0]!.reviewId, {
      decision: 'rejected',
      reviewer: 'operations@example.com',
    });

    await expect(handle.result()).resolves.toMatchObject({
      orderId: rejectedOrderInput.orderId,
      refundId: expect.stringContaining('refund_'),
      releasedReservationIds: expect.arrayContaining([expect.stringContaining('res_')]),
      status: 'cancelled',
    });
  });

  it('compensates inventory and payment when cancellation arrives before shipment', async () => {
    await using engine = createOrderProcessingEngine(new TestEngine());

    const handle = await engine.start(
      'orderProcessingOrder',
      {
        ...standardOrderInput,
        allowCancellationBeforeShipment: true,
      },
      {
        id: standardOrderInput.orderId,
      },
    );

    await handle.signal(cancelOrderSignal, { reason: 'customer-requested' });

    await expect(handle.result()).resolves.toMatchObject({
      orderId: standardOrderInput.orderId,
      refundId: expect.stringContaining('refund_'),
      releasedReservationIds: expect.arrayContaining([expect.stringContaining('res_')]),
      status: 'cancelled',
    });
  });

  it('ships standard orders when no cancellation signal arrives', async () => {
    await using engine = createOrderProcessingEngine(new TestEngine());

    const handle = await engine.start('orderProcessingOrder', {
      ...standardOrderInput,
      orderId: 'order_standard_ship',
    });

    await engine.advanceTime(1);

    await expect(handle.result()).resolves.toMatchObject({
      orderId: 'order_standard_ship',
      status: 'shipped',
      trackingNumber: expect.stringContaining('trk_'),
    });
  });

  it('rejects item updates once inventory reservation has started', async () => {
    await using engine = createOrderProcessingEngine(new TestEngine());

    const handle = await engine.start(
      'orderProcessingOrder',
      {
        ...standardOrderInput,
        allowCancellationBeforeShipment: true,
        itemUpdateWindowMs: 1_000,
        orderId: 'order_update_closed',
      },
      {
        id: 'order_update_closed',
      },
    );

    await engine.advanceTime(1_000);

    await expect(
      handle.update(addItemUpdate, {
        sku: 'late-item',
        quantity: 1,
        warehouseId: 'denver' as const,
        unitPrice: 5,
      }),
    ).resolves.toEqual({
      accepted: false,
      reason: 'Orders can only be changed before inventory reservation starts.',
      status: 'awaiting-shipment',
    });

    await handle.signal(cancelOrderSignal, { reason: 'cleanup' });
    await expect(handle.result()).resolves.toMatchObject({
      orderId: 'order_update_closed',
      status: 'cancelled',
    });
  });

  it('uses the scheduled sweep workflow to cancel stale running orders', async () => {
    await using engine = createOrderProcessingEngine(new TestEngine());

    const handle = await engine.start('orderProcessingOrder', {
      ...standardOrderInput,
      allowCancellationBeforeShipment: true,
      orderId: 'order_stale',
    });

    const scheduleHandle = await engine.schedule(orderProcessingSchedule);
    await expect(engine.getSchedule(scheduleHandle.id)).resolves.toMatchObject({
      id: scheduleHandle.id,
      status: 'active',
      workflowType: 'orderProcessingSweepStaleOrders',
    });
    await expect(
      engine.listSchedules({ workflowType: 'orderProcessingSweepStaleOrders' }),
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ id: scheduleHandle.id })],
    });

    const scheduleDescription = await scheduleHandle.describe();
    expect(scheduleDescription.nextFireAt).toBeNumber();
    await engine.advanceTime(scheduleDescription.nextFireAt! - engine.now);
    const workflows = await engine.list();
    const sweepWorkflow = workflows.items.find(
      (workflow) => workflow.type === 'orderProcessingSweepStaleOrders',
    );
    expect(sweepWorkflow).toMatchObject({
      status: 'completed',
      type: 'orderProcessingSweepStaleOrders',
    });

    const sweepResult = await engine.getHandle(sweepWorkflow!.id).result();
    expect(sweepResult).toEqual({
      cancelledOrderIds: ['order_stale'],
      scannedOrderCount: 1,
    });
    await handle.signal(cancelOrderSignal, { reason: 'stale-order-sweep' });

    await expect(handle.result()).resolves.toMatchObject({
      orderId: 'order_stale',
      status: 'cancelled',
    });
  });
});

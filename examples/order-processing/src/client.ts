import { Engine, WorkflowAlreadyExistsError, type WorkflowHandle } from '@lostgradient/weft';
import { SQLiteStorage } from '@lostgradient/weft/storage/sqlite';

import { addItemUpdate, cancelOrderSignal, orderStatusQuery } from './messages';
import { calculateOrderTotal, type AddItemInput, type OrderProcessingInput } from './model';
import { createOrderProcessingEngine } from './registry';
import { highValueOrderInput, standardOrderInput } from './sample-data';

const command = Bun.argv[2] ?? 'place';
const databasePath = Bun.env['WEFT_DATABASE_PATH'] ?? './order-processing.sqlite';

if (import.meta.main) {
  using storage = new SQLiteStorage(databasePath);
  await using engine = createOrderProcessingEngine(new Engine({ storage }));
  await engine.recoverAll({ acknowledgeUnknownWorkflowTypes: true });

  switch (command) {
    case 'place': {
      const handle = await startOrResume(engine, highValueOrderInput.orderId, highValueOrderInput);
      const giftWrapItem: AddItemInput = {
        quantity: 1,
        sku: 'gift-wrap',
        unitPrice: 5,
        warehouseId: 'denver',
      };
      const status = await handle.query(orderStatusQuery);
      if (
        status.status === 'received' &&
        status.totalAmount === calculateOrderTotal(highValueOrderInput.items)
      ) {
        await handle.update(addItemUpdate, giftWrapItem);
      }
      const reviews = await engine.listReviews({ workflowId: highValueOrderInput.orderId });
      console.log({
        orderId: highValueOrderInput.orderId,
        pendingReviewId: reviews[0]?.reviewId ?? null,
        statusQuery: orderStatusQuery.name,
      });
      break;
    }
    case 'approve': {
      const [review] = await engine.listReviews({ workflowId: highValueOrderInput.orderId });
      if (!review) throw new Error('No pending high-value order review found.');
      await engine.submitReview(review.reviewId, {
        decision: 'approved',
        reviewer: 'operations@example.com',
      });
      const handle = engine.getHandle(highValueOrderInput.orderId);
      console.log(await handle.result());
      break;
    }
    case 'cancel': {
      const cancellableOrderInput: OrderProcessingInput = {
        ...standardOrderInput,
        allowCancellationBeforeShipment: true,
      };
      const handle = await startOrResume(
        engine,
        cancellableOrderInput.orderId,
        cancellableOrderInput,
      );
      await handle.signal(cancelOrderSignal, { reason: 'customer-requested' });
      console.log(await handle.result());
      break;
    }
    case 'list': {
      console.log(
        await engine.list({ attributes: [{ key: 'orderStatus', value: 'awaiting-review' }] }),
      );
      break;
    }
    default:
      throw new Error(`Unknown command "${command}". Use place, approve, cancel, or list.`);
  }
}

async function startOrResume(
  engine: Engine,
  workflowId: string,
  input: OrderProcessingInput,
): Promise<WorkflowHandle> {
  try {
    return await engine.start('orderProcessingOrder', input, {
      id: workflowId,
      searchAttributes: {
        customerId: input.customerId,
        orderStatus: 'received',
        totalAmount: calculateOrderTotal(input.items),
      },
    });
  } catch (error) {
    if (!(error instanceof WorkflowAlreadyExistsError)) throw error;
    return engine.getHandle(workflowId);
  }
}

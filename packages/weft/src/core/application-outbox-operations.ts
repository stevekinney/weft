/**
 * Operator transitions for the application delivery outbox (WFT-85): retrying
 * a parked, dead-lettered, or rejected delivery, and closing a parked one for
 * good.
 *
 * Both are ordinary compare-and-swap transitions on a terminal record. A retry
 * reopens the delivery — its open-count and due-index maintenance ride in the
 * same batch — and a dead-letter moves its retention entry to the new terminal
 * instant.
 *
 * @module core/application-outbox-operations
 */

import type { ApplicationDeliveryOperatorResult } from './application-outbox-contract.ts';
import { capacityOf } from './application-outbox-enqueue.ts';
import {
  ApplicationOutboxContentionError,
  commitDeliveryTransition,
  MAX_OUTBOX_TRANSITION_ATTEMPTS,
  toApplicationDeliveryReceipt,
  type OutboxRuntime,
} from './application-outbox-internals.ts';
import { loadDelivery, loadOutboxHeader } from './application-outbox-storage.ts';
import { isTerminalDeliveryRecord } from './application-outbox-transition-helpers.ts';
import {
  deadLetterDeliveryByOperator,
  retryDeliveryByOperator,
  type ApplicationOutboxTransition,
} from './application-outbox-transitions.ts';
import type { ApplicationDeliveryRecord } from './application-outbox-types.ts';

async function operate(
  runtime: OutboxRuntime,
  deliveryId: string,
  operation: string,
  decide: (
    record: ApplicationDeliveryRecord,
    now: number,
  ) => ApplicationOutboxTransition<ApplicationDeliveryRecord>,
): Promise<ApplicationDeliveryOperatorResult> {
  for (let attempt = 1; attempt <= MAX_OUTBOX_TRANSITION_ATTEMPTS; attempt += 1) {
    const loaded = await loadDelivery(runtime.storage, runtime.keys, deliveryId);
    if (loaded === null) return { status: 'unknown' };
    const now = runtime.now();
    const transition = decide(loaded.record, now);
    if (!transition.ok) {
      return { status: 'not-applicable', receipt: toApplicationDeliveryReceipt(loaded.record) };
    }
    // Reopening a terminal delivery is an admission: it must respect the same
    // backlog ceiling enqueue does, checked on the header bytes the commit
    // then fences on.
    const header = await loadOutboxHeader(
      runtime.storage,
      runtime.keys,
      runtime.policy.namespace,
      runtime.policy.ownerId,
    );
    if (
      !isTerminalDeliveryRecord(transition.next) &&
      header.record.openCount >= runtime.policy.maxBacklog
    ) {
      return {
        status: 'rejected',
        reason: 'backlog-full',
        capacity: capacityOf(runtime, header.record.openCount, header.record.enqueuedCount),
      };
    }
    const committed = await commitDeliveryTransition(runtime, {
      previous: loaded.record,
      expectedBytes: loaded.bytes,
      next: transition.next,
      now,
      header,
    });
    if (!committed) continue;
    return { status: 'applied', receipt: toApplicationDeliveryReceipt(transition.next) };
  }
  throw new ApplicationOutboxContentionError(operation, deliveryId);
}

/** Return a parked, dead-lettered, or rejected delivery to the due index with one more attempt. */
export function retryDelivery(
  runtime: OutboxRuntime,
  deliveryId: string,
): Promise<ApplicationDeliveryOperatorResult> {
  return operate(runtime, deliveryId, 'retry', (record, now) =>
    retryDeliveryByOperator(record, { now }),
  );
}

/** Close a parked `unknown-outcome` delivery as dead-lettered. */
export function deadLetterDelivery(
  runtime: OutboxRuntime,
  deliveryId: string,
  reason: string | undefined,
): Promise<ApplicationDeliveryOperatorResult> {
  return operate(runtime, deliveryId, 'deadLetter', (record, now) =>
    deadLetterDeliveryByOperator(record, { now, reason }),
  );
}

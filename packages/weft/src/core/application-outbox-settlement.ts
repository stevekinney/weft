/**
 * Attempt-fenced settlement for the application delivery outbox (WFT-85):
 * marking an attempt begun, heartbeat, reporting the transport outcome,
 * cancellation, and the cleanup-state read.
 *
 * Every function proves the caller holds the current attempt before it writes
 * anything, and re-reads durable state after a lost compare-and-swap rather
 * than retrying with stale bytes. A stale claimant therefore cannot begin,
 * heartbeat, settle, or cancel a newer attempt.
 *
 * Heartbeat is the one mutation that emits no fleet event: it is liveness
 * evidence, not a disposition.
 *
 * @module core/application-outbox-settlement
 */

import type {
  ApplicationDeliveryCancellationResult,
  ApplicationDeliveryCleanupResult,
  ApplicationDeliveryHeartbeatResult,
  ApplicationDeliverySettleResult,
} from './application-outbox-contract.ts';
import {
  ApplicationOutboxContentionError,
  commitDeliveryTransition,
  MAX_OUTBOX_TRANSITION_ATTEMPTS,
  releaseAttemptController,
  releaseAttemptsForDelivery,
  toApplicationDeliveryReceipt,
  type OutboxRuntime,
} from './application-outbox-internals.ts';
import {
  commitOutboxTransition,
  loadDelivery,
  planDeliveryTransition,
} from './application-outbox-storage.ts';
import {
  isTerminalDeliveryRecord,
  type ApplicationOutboxTransitionRejection,
} from './application-outbox-transition-helpers.ts';
import {
  beginDeliveryAttempt,
  heartbeatDeliveryAttempt,
  requestDeliveryCancellation,
  settleDeliveryAttempt,
  type ApplicationOutboxTransition,
} from './application-outbox-transitions.ts';
import {
  isApplicationDeliveryLeased,
  type ApplicationDeliveryRecord,
} from './application-outbox-types.ts';
import type { ValidatedOutcome } from './application-outbox-validation.ts';
import { leaseCommitSerial } from './application-primitive-attempt-registry.ts';
import type { JSONValue } from './json.ts';

function refusal(
  reason: string,
  record: ApplicationDeliveryRecord,
): {
  status: 'stale' | 'deadline-exceeded';
  receipt: ReturnType<typeof toApplicationDeliveryReceipt>;
} {
  return {
    status: reason === 'deadline-exceeded' ? 'deadline-exceeded' : 'stale',
    receipt: toApplicationDeliveryReceipt(record),
  };
}

/** Release the caller's process-local registration when its attempt is refused. */
function releaseRefusedAttempt(
  runtime: OutboxRuntime,
  deliveryId: string,
  attemptToken: string,
): void {
  releaseAttemptController(
    runtime,
    attemptToken,
    'This attempt is no longer current: its request was refused.',
    deliveryId,
  );
}

/**
 * Report an edge the record refuses. The holder itself asking for an edge its
 * lease does not need — a repeated begin on a record already attempting, or
 * a settle before the send began — keeps its controller live, because the
 * lease is live and current; only a stale, expired, missing, or cancelled
 * attempt is released. A repeated begin after cancellation was requested is
 * refused, so the holder cannot read it as permission to call the transport.
 */
function refuse(
  runtime: OutboxRuntime,
  deliveryId: string,
  attemptToken: string,
  reason: ApplicationOutboxTransitionRejection,
  record: ApplicationDeliveryRecord,
): ApplicationDeliverySettleResult {
  if (reason === 'not-applicable') {
    return { status: 'settled', receipt: toApplicationDeliveryReceipt(record) };
  }
  if (reason === 'not-attempting') {
    return { status: 'stale', receipt: toApplicationDeliveryReceipt(record) };
  }
  releaseRefusedAttempt(runtime, deliveryId, attemptToken);
  return refusal(reason, record);
}

/**
 * The shared shape of every attempt-fenced write: decide the next record from
 * the current one, commit it, and report.
 */
async function fenced(
  runtime: OutboxRuntime,
  deliveryId: string,
  attemptToken: string,
  operation: string,
  decide: (
    record: ApplicationDeliveryRecord,
    now: number,
  ) => ApplicationOutboxTransition<ApplicationDeliveryRecord>,
): Promise<ApplicationDeliverySettleResult> {
  for (let attempt = 1; attempt <= MAX_OUTBOX_TRANSITION_ATTEMPTS; attempt += 1) {
    const loaded = await loadDelivery(runtime.storage, runtime.keys, deliveryId);
    if (loaded === null) {
      releaseRefusedAttempt(runtime, deliveryId, attemptToken);
      return { status: 'unknown' };
    }
    // A write already in flight when the outbox was disposed must not land:
    // the caller may have released the storage with the handle. The record
    // stays as it is for a maintenance pass elsewhere to recover.
    if (runtime.disposal.aborted) {
      return { status: 'stale', receipt: toApplicationDeliveryReceipt(loaded.record) };
    }
    // Fresh clock after the asynchronous load: a request that began inside the
    // attempt deadline can cross it during the read.
    const now = runtime.now();
    const transition = decide(loaded.record, now);
    if (!transition.ok) {
      return refuse(runtime, deliveryId, attemptToken, transition.reason, loaded.record);
    }
    const committed = await commitDeliveryTransition(runtime, {
      previous: loaded.record,
      expectedBytes: loaded.bytes,
      next: transition.next,
      now,
    });
    if (!committed) continue;
    if (
      isTerminalDeliveryRecord(transition.next) ||
      !isApplicationDeliveryLeased(transition.next)
    ) {
      releaseAttemptController(
        runtime,
        attemptToken,
        'The application outbox released this attempt when the delivery settled.',
      );
      return {
        status: isTerminalDeliveryRecord(transition.next) ? 'settled' : 'retrying',
        receipt: toApplicationDeliveryReceipt(transition.next),
      };
    }
    return { status: 'settled', receipt: toApplicationDeliveryReceipt(transition.next) };
  }
  throw new ApplicationOutboxContentionError(operation, deliveryId);
}

/**
 * Durably mark that the current attempt is about to call the transport.
 * `settled` here means the `attempting` record committed; the receipt says so.
 */
export function beginAttempt(
  runtime: OutboxRuntime,
  options: { readonly deliveryId: string; readonly attemptToken: string },
): Promise<ApplicationDeliverySettleResult> {
  return fenced(runtime, options.deliveryId, options.attemptToken, 'begin', (record, now) =>
    beginDeliveryAttempt(record, { attemptToken: options.attemptToken, now }),
  );
}

/**
 * Record liveness and extend visibility for the current attempt, clamped to
 * the fixed attempt deadline. The returned `cancellationRequested` flag is the
 * cross-process cancellation channel.
 */
export async function heartbeatAttempt(
  runtime: OutboxRuntime,
  options: {
    readonly deliveryId: string;
    readonly attemptToken: string;
    readonly transportActivity?: JSONValue | undefined;
  },
): Promise<ApplicationDeliveryHeartbeatResult> {
  for (let attempt = 1; attempt <= MAX_OUTBOX_TRANSITION_ATTEMPTS; attempt += 1) {
    const loaded = await loadDelivery(runtime.storage, runtime.keys, options.deliveryId);
    if (loaded === null) {
      releaseRefusedAttempt(runtime, options.deliveryId, options.attemptToken);
      return { status: 'unknown' };
    }
    // A renewal already in flight when the outbox was disposed must not write:
    // the caller may have released the storage with the handle, and the
    // runner that asked for the renewal has stopped waiting for it.
    if (runtime.disposal.aborted) {
      return { status: 'stale', receipt: toApplicationDeliveryReceipt(loaded.record) };
    }
    const now = runtime.now();
    const transition = heartbeatDeliveryAttempt(loaded.record, {
      attemptToken: options.attemptToken,
      now,
      transportActivity: options.transportActivity,
    });
    if (!transition.ok) {
      releaseRefusedAttempt(runtime, options.deliveryId, options.attemptToken);
      return refusal(transition.reason, loaded.record);
    }
    const committed = await commitOutboxTransition(
      runtime.storage,
      runtime.events,
      planDeliveryTransition(runtime.keys, {
        previous: loaded.record,
        expectedBytes: loaded.bytes,
        next: transition.next,
        event: null,
        now,
      }),
    );
    if (!committed) continue;
    return {
      status: 'renewed',
      visibilityExpiresAt: transition.next.visibilityExpiresAt,
      attemptDeadlineAt: transition.next.attemptDeadlineAt,
      cancellationRequested: transition.next.state === 'cancellation-requested',
      receipt: toApplicationDeliveryReceipt(transition.next),
    };
  }
  throw new ApplicationOutboxContentionError('heartbeat', options.deliveryId);
}

/** Settle the current attempt on a validated transport outcome. */
export function settleAttempt(
  runtime: OutboxRuntime,
  options: {
    readonly deliveryId: string;
    readonly attemptToken: string;
    readonly outcome: ValidatedOutcome;
  },
): Promise<ApplicationDeliverySettleResult> {
  return fenced(runtime, options.deliveryId, options.attemptToken, 'settle', (record, now) =>
    settleDeliveryAttempt(record, {
      attemptToken: options.attemptToken,
      now,
      outcome: options.outcome,
      retryBackoffMs: runtime.policy.retryBackoffMs,
      maxRetryBackoffMs: runtime.policy.maxRetryBackoffMs,
    }),
  );
}

function abortLocalClaimant(runtime: OutboxRuntime, attemptToken: string): void {
  const registration = runtime.attemptControllers.get(attemptToken);
  if (registration !== undefined && !registration.controller.signal.aborted) {
    registration.controller.abort(new Error('The application outbox cancelled this delivery.'));
  }
}

/** Release every local attempt on a delivery observed terminal or gone, fenced by the snapshot's serial. */
function releaseTerminalAttempts(runtime: OutboxRuntime, deliveryId: string, observedAt: number) {
  releaseAttemptsForDelivery(
    runtime,
    deliveryId,
    'This delivery is terminal; its attempt is over.',
    undefined,
    observedAt,
  );
}

/**
 * Record a durable cancellation request and, when the claimant is in this
 * process, abort its attempt-scoped signal after the record commits.
 */
export async function requestCancellation(
  runtime: OutboxRuntime,
  options: { readonly deliveryId: string; readonly reason?: string | undefined },
): Promise<ApplicationDeliveryCancellationResult> {
  for (let attempt = 1; attempt <= MAX_OUTBOX_TRANSITION_ATTEMPTS; attempt += 1) {
    const observedAt = leaseCommitSerial();
    const loaded = await loadDelivery(runtime.storage, runtime.keys, options.deliveryId);
    if (loaded === null) {
      releaseTerminalAttempts(runtime, options.deliveryId, observedAt);
      return { status: 'unknown' };
    }
    const now = runtime.now();
    const transition = requestDeliveryCancellation(loaded.record, { now, reason: options.reason });
    if (!transition.ok) {
      // The idempotent repeat: the request stands and the same attempt owns
      // settlement, so re-abort (a no-op when already aborted) and report what
      // the first call reported.
      if (transition.reason === 'not-leased' && isApplicationDeliveryLeased(loaded.record)) {
        abortLocalClaimant(runtime, loaded.record.attemptToken);
        return {
          status: 'requested',
          receipt: toApplicationDeliveryReceipt(loaded.record),
          cleanupPending: true,
        };
      }
      releaseTerminalAttempts(runtime, options.deliveryId, observedAt);
      return { status: 'already-terminal', receipt: toApplicationDeliveryReceipt(loaded.record) };
    }
    const committed = await commitDeliveryTransition(runtime, {
      previous: loaded.record,
      expectedBytes: loaded.bytes,
      next: transition.next,
      now,
    });
    if (!committed) continue;
    if (transition.next.state === 'cancellation-requested') {
      abortLocalClaimant(runtime, transition.next.attemptToken);
      return {
        status: 'requested',
        receipt: toApplicationDeliveryReceipt(transition.next),
        cleanupPending: true,
      };
    }
    // A merely claimed delivery cancelled outright: its claimant, if local,
    // learns through its signal that there is nothing left to send.
    if (isApplicationDeliveryLeased(loaded.record)) {
      releaseAttemptController(
        runtime,
        loaded.record.attemptToken,
        'The application outbox cancelled this delivery before its send began.',
      );
    }
    return { status: 'cancelled', receipt: toApplicationDeliveryReceipt(transition.next) };
  }
  throw new ApplicationOutboxContentionError('cancel', options.deliveryId);
}

/**
 * Read whether a cancelled delivery's attempt has finished. `pending` means
 * the outbox has not seen the attempt settle, never that the transport
 * stopped.
 */
export async function readCleanupState(
  runtime: OutboxRuntime,
  deliveryId: string,
): Promise<ApplicationDeliveryCleanupResult> {
  const observedAt = leaseCommitSerial();
  const loaded = await loadDelivery(runtime.storage, runtime.keys, deliveryId);
  if (loaded === null) {
    releaseAttemptsForDelivery(
      runtime,
      deliveryId,
      'This delivery no longer exists; its receipt was retired.',
      undefined,
      observedAt,
    );
    return { status: 'unknown' };
  }
  releaseAttemptsForDelivery(
    runtime,
    deliveryId,
    'This attempt is no longer the current lease on its delivery.',
    isApplicationDeliveryLeased(loaded.record) ? loaded.record.attemptToken : undefined,
    observedAt,
  );
  const receipt = toApplicationDeliveryReceipt(loaded.record);
  if (receipt.terminalAt !== undefined && receipt.cleanupPending !== true) {
    return { status: 'settled', receipt };
  }
  return { status: 'pending', receipt };
}

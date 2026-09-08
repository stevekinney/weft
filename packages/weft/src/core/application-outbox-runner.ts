/**
 * The adapter runner for the application delivery outbox (WFT-85): one due
 * delivery claimed, durably marked `attempting`, handed to the configured
 * transport, and settled on what the transport reported — and the bounded
 * drain that repeats it.
 *
 * The runner never trusts the adapter's completion as a disposition. It
 * validates the outcome, then commits the matching transition fenced on the
 * attempt token and the `attempting` bytes; only that commit moves the record.
 * A thrown adapter error is an unknown outcome, because the request may have
 * left the process. When the attempt deadline elapses while the send is in
 * flight the runner stops waiting, treats the result as unknown, and aborts
 * the adapter's signal as it releases the attempt.
 *
 * @module core/application-outbox-runner
 */

import type {
  ApplicationDeliveryAdapter,
  ApplicationDeliveryClaim,
  ApplicationDeliveryReceipt,
  ApplicationOutboxDeliverResult,
  ApplicationOutboxDrainReport,
} from './application-outbox-contract.ts';
import { claimNextDelivery } from './application-outbox-delivery.ts';
import {
  ApplicationDeliveryValidationError,
  boundFailureMessage,
  requireWaitBudget,
} from './application-outbox-guards.ts';
import {
  releaseAttemptController,
  toApplicationDeliveryReceipt,
  type OutboxRuntime,
} from './application-outbox-internals.ts';
import { runOutboxMaintenance } from './application-outbox-maintenance.ts';
import { beginAttempt, heartbeatAttempt, settleAttempt } from './application-outbox-settlement.ts';
import { loadDelivery, loadOutboxHeader } from './application-outbox-storage.ts';
import { validateOutcome, type ValidatedOutcome } from './application-outbox-validation.ts';
import { raceAbortWithin, WaitBudgetElapsedError } from './application-primitive-abort.ts';
import { delayUnlessAborted } from './application-primitive-timing.ts';

/**
 * Call the adapter once, bounded by the attempt deadline and the attempt's
 * abort signal, and return a validated outcome. Never throws for anything the
 * adapter did: an error or a lost race is an unknown outcome.
 */
async function sendOnce(
  runtime: OutboxRuntime,
  adapter: ApplicationDeliveryAdapter,
  claim: ApplicationDeliveryClaim,
  requestSignal: AbortSignal | undefined,
): Promise<ValidatedOutcome> {
  // An abort that landed while the begin was committing, or an attempt
  // deadline that passed during it, means nothing was sent: the attempt is
  // over, but the delivery is safe to try again.
  const budget = claim.attemptDeadlineAt - runtime.now();
  if (claim.signal.aborted || requestSignal?.aborted === true || budget <= 0) {
    return {
      status: 'retryable',
      failure: {
        reason: 'retryable',
        message: 'The attempt ended before the transport was called.',
      },
      retryAfterMs: undefined,
    };
  }
  const raced = await raceAbortWithin(
    async () => {
      try {
        return {
          ok: true as const,
          outcome: validateOutcome(
            await adapter.send({
              delivery: claim.receipt,
              payload: claim.payload,
              credentialRef: claim.credentialRef,
              attemptToken: claim.attemptToken,
              signal: claim.signal,
            }),
          ),
        };
      } catch (error) {
        return { ok: false as const, error };
      }
    },
    budget,
    claim.signal,
    requestSignal,
  );
  if (raced.aborted) {
    return {
      status: 'unknown',
      failure: {
        reason: 'unknown-outcome',
        message:
          raced.reason instanceof WaitBudgetElapsedError
            ? 'The attempt deadline passed while the transport call was in flight.'
            : 'The attempt was aborted while the transport call was in flight.',
      },
    };
  }
  if (raced.value.ok) return raced.value.outcome;
  return {
    status: 'unknown',
    failure: {
      reason: 'unknown-outcome',
      message: boundFailureMessage(
        `The transport adapter threw: ${describeError(raced.value.error)}`,
      ),
    },
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    // A thrown value whose own stringification throws still has to become a
    // bounded diagnostic rather than a second exception out of the runner.
    return 'a value that could not be converted to a string';
  }
}

/**
 * Claim the earliest due delivery, run it through the adapter, and settle it.
 *
 * The `attempting` commit happens before the adapter is called; a claim whose
 * begin is refused (cancelled or reclaimed between the two) is released
 * without calling the transport.
 */
export async function deliverNext(
  runtime: OutboxRuntime,
  options?: { readonly signal?: AbortSignal | undefined },
): Promise<ApplicationOutboxDeliverResult> {
  const adapter = requireAdapter(runtime);
  const claimed = await claimNextDelivery(runtime, options);
  if (claimed.status !== 'claimed') return claimed;
  const { claim } = claimed;
  const deliveryId = claim.receipt.deliveryId;
  // A caller that aborted while the claim was committing gets no send at all:
  // the lease is left to lapse in `claimed`, which maintenance reschedules as
  // a provably unsent attempt.
  if (options?.signal?.aborted === true) {
    releaseAttemptController(
      runtime,
      claim.attemptToken,
      'The delivery request was aborted before the send began.',
      deliveryId,
    );
    return { status: 'settled', receipt: claim.receipt, committed: false };
  }
  const begun = await beginAttempt(runtime, { deliveryId, attemptToken: claim.attemptToken });
  if (begun.status !== 'settled') {
    return {
      status: 'settled',
      receipt: await currentReceipt(runtime, deliveryId, begun),
      committed: false,
    };
  }
  const stopRenewing = keepLeaseAlive(runtime, claim);
  const stopForwarding = forwardAbort(runtime, claim.attemptToken, options?.signal);
  let outcome: ValidatedOutcome;
  try {
    outcome = await sendOnce(
      runtime,
      adapter,
      { ...claim, receipt: begun.receipt },
      options?.signal,
    );
  } finally {
    stopRenewing();
    stopForwarding();
  }
  // Disposal mid-send aborted the adapter; a caller that disposed the handle
  // may already have released the storage behind it, so nothing more is
  // written. The lease stays `attempting` for a maintenance pass to recover
  // as an unknown outcome, which is exactly what it is.
  if (runtime.disposal.aborted) {
    return { status: 'settled', receipt: begun.receipt, committed: false };
  }
  const settled = await settleAttempt(runtime, {
    deliveryId,
    attemptToken: claim.attemptToken,
    outcome,
  });
  releaseAttemptController(
    runtime,
    claim.attemptToken,
    'The application outbox finished this attempt.',
    deliveryId,
  );
  return {
    status: 'settled',
    receipt: await currentReceipt(runtime, deliveryId, settled),
    committed: settled.status === 'settled' || settled.status === 'retrying',
  };
}

function requireAdapter(runtime: OutboxRuntime): ApplicationDeliveryAdapter {
  if (runtime.adapter === undefined) {
    throw new ApplicationDeliveryValidationError(
      'deliverNext() and drain() require an adapter; construct the outbox with one or drive claims directly.',
    );
  }
  return runtime.adapter;
}

/**
 * Forward the caller's abort to the attempt's controller while the send is in
 * flight, so an aborted `deliverNext()` or `drain()` reaches the adapter
 * through the signal it was handed rather than waiting out the attempt.
 */
function forwardAbort(
  runtime: OutboxRuntime,
  attemptToken: string,
  requestSignal: AbortSignal | undefined,
): () => void {
  if (requestSignal === undefined) return () => undefined;
  const onAbort = (): void => {
    const registration = runtime.attemptControllers.get(attemptToken);
    if (registration !== undefined && !registration.controller.signal.aborted) {
      registration.controller.abort(requestSignal.reason as unknown);
    }
  };
  if (requestSignal.aborted) {
    onAbort();
    return () => undefined;
  }
  requestSignal.addEventListener('abort', onAbort, { once: true });
  return () => {
    requestSignal.removeEventListener('abort', onAbort);
  };
}

/**
 * Renew the attempt's visibility while the adapter runs, at half the window
 * it was granted, so a send that outlasts `visibilityTimeoutMs` but stays
 * inside the attempt deadline is not reclaimed underneath the transport.
 *
 * A refused renewal — the lease was recovered elsewhere, the deadline passed,
 * or the record is gone — releases the attempt's controller, so the transport
 * is told to stop through its signal and whatever it returns afterwards
 * settles as `stale`.
 */
function keepLeaseAlive(runtime: OutboxRuntime, claim: ApplicationDeliveryClaim): () => void {
  const deliveryId = claim.receipt.deliveryId;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  // The last expiry durable storage confirmed. Renewal is retried only inside
  // this window: past it the lease may already belong to someone else.
  let confirmedExpiresAt = claim.visibilityExpiresAt;
  const abort = (reason: string): void => {
    const registration = runtime.attemptControllers.get(claim.attemptToken);
    if (registration !== undefined && !registration.controller.signal.aborted) {
      registration.controller.abort(new Error(reason));
    }
  };
  const arm = (): void => {
    if (stopped) return;
    const remaining = confirmedExpiresAt - runtime.now();
    if (remaining <= 0) {
      abort('The attempt lease expired before its renewal could be confirmed.');
      return;
    }
    timer = setTimeout(
      () => {
        timer = null;
        void renew();
      },
      Math.max(1, Math.floor(remaining / 2)),
    );
    timer.unref?.();
  };
  const renew = async (): Promise<void> => {
    if (stopped) return;
    let result: Awaited<ReturnType<typeof heartbeatAttempt>>;
    try {
      result = await heartbeatAttempt(runtime, { deliveryId, attemptToken: claim.attemptToken });
    } catch {
      // A storage failure during renewal is not a verdict on the lease; try
      // again while the last confirmed window still holds, and abort once it
      // cannot be confirmed before expiry.
      arm();
      return;
    }
    if (stopped) return;
    // A refused renewal has already released the attempt's controller — the
    // settlement path aborts the signal as it refuses — so there is nothing
    // left to do here but stop renewing.
    if (result.status !== 'renewed') return;
    confirmedExpiresAt = result.visibilityExpiresAt;
    // Cancellation requested in another process reaches this runner only
    // through the renewal; the transport is told to stop the same way an
    // in-process request tells it.
    if (result.cancellationRequested) {
      abort('The application outbox cancelled this delivery.');
      return;
    }
    arm();
  };
  arm();
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
  };
}

/** The receipt a refused or settled step reports, re-read when the step carried none. */
async function currentReceipt(
  runtime: OutboxRuntime,
  deliveryId: string,
  result: { readonly status: string; readonly receipt?: ApplicationDeliveryReceipt },
): Promise<ApplicationDeliveryReceipt> {
  if (result.receipt !== undefined) return result.receipt;
  const loaded = await loadDelivery(runtime.storage, runtime.keys, deliveryId);
  if (loaded !== null) return toApplicationDeliveryReceipt(loaded.record);
  throw new ApplicationDeliveryValidationError(
    `Delivery "${deliveryId}" was retired while its attempt was in flight.`,
  );
}

type DrainCounters = {
  acknowledged: number;
  rejected: number;
  retryScheduled: number;
  deadLettered: number;
  cancelled: number;
  unknown: number;
};

function count(counters: DrainCounters, receipt: ApplicationDeliveryReceipt): void {
  switch (receipt.state) {
    case 'acknowledged':
      counters.acknowledged += 1;
      break;
    case 'rejected':
      counters.rejected += 1;
      break;
    case 'retry-scheduled':
      counters.retryScheduled += 1;
      break;
    case 'dead-lettered':
      counters.deadLettered += 1;
      break;
    case 'cancelled':
      counters.cancelled += 1;
      break;
    case 'unknown-outcome':
      counters.unknown += 1;
      break;
    default:
      break;
  }
}

/**
 * Deliver everything that is due, then everything that becomes due within the
 * budget, running a maintenance pass between rounds so lapsed leases are
 * recovered. Reports counts only, and `pending` from the durable header, so
 * a forced stop never claims anything it did not commit.
 */
export async function drainOutbox(
  runtime: OutboxRuntime,
  options: {
    readonly timeoutMs: number;
    readonly signal?: AbortSignal | undefined;
    readonly pollIntervalMs?: number | undefined;
  },
): Promise<ApplicationOutboxDrainReport> {
  const { timeoutMs, pollIntervalMs } = requireWaitBudget(options);
  const deadline = runtime.now() + timeoutMs;
  const counters: DrainCounters = {
    acknowledged: 0,
    rejected: 0,
    retryScheduled: 0,
    deadLettered: 0,
    cancelled: 0,
    unknown: 0,
  };
  let drained = false;
  while (!runtime.disposal.aborted && options.signal?.aborted !== true) {
    // Dispositions the maintenance pass commits are the drain's work too: a
    // lease that lapsed after its send began is parked or dead-lettered here,
    // and the report must say so rather than counting only what the adapter
    // settled.
    const maintained = await runOutboxMaintenance(runtime, runtime.now());
    counters.unknown += maintained.parked;
    counters.deadLettered += maintained.deadLettered;
    counters.retryScheduled += maintained.rescheduled;
    const result = await deliverNext(runtime, options);
    if (result.status === 'settled') {
      // Only what this drain committed is this drain's to report; a disposition
      // another worker won belongs to that worker's accounting.
      if (result.committed) count(counters, result.receipt);
      continue;
    }
    const header = await loadOutboxHeader(
      runtime.storage,
      runtime.keys,
      runtime.policy.namespace,
      runtime.policy.ownerId,
    );
    if (header.record.openCount === 0) {
      drained = true;
      break;
    }
    const remaining = deadline - runtime.now();
    if (remaining <= 0) break;
    const wait =
      result.status === 'held'
        ? Math.min(remaining, Math.max(1, result.availableAt - runtime.now()))
        : Math.min(remaining, pollIntervalMs);
    if (!(await delayUnlessAborted(wait, runtime.disposal, options.signal))) break;
  }
  const header = await loadOutboxHeader(
    runtime.storage,
    runtime.keys,
    runtime.policy.namespace,
    runtime.policy.ownerId,
  );
  return Object.freeze({ ...counters, pending: header.record.openCount, drained });
}

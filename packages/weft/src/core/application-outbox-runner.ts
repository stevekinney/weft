/**
 * The adapter runner for the application delivery outbox (WFT-85): one due
 * delivery claimed, durably marked `attempting`, handed to the configured
 * transport, and settled on what the transport reported. The bounded drain
 * that repeats it lives in `application-outbox-drain.ts`.
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
} from './application-outbox-contract.ts';
import { claimNextDelivery } from './application-outbox-delivery.ts';
import {
  ApplicationDeliveryValidationError,
  boundFailureMessage,
} from './application-outbox-guards.ts';
import {
  releaseAttemptController,
  toApplicationDeliveryReceipt,
  type OutboxRuntime,
} from './application-outbox-internals.ts';
import { beginAttempt, heartbeatAttempt, settleAttempt } from './application-outbox-settlement.ts';
import { loadDelivery } from './application-outbox-storage.ts';
import { validateOutcome, type ValidatedOutcome } from './application-outbox-validation.ts';
import { raceAbortWithin, WaitBudgetElapsedError } from './application-primitive-abort.ts';

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
  if (raced.aborted) return unknownAfterLostRace(runtime, claim, raced.reason);
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

/**
 * The unknown outcome for a send the race abandoned. When the attempt deadline
 * won, the adapter is told at once through its signal — before the settlement
 * that follows, whose storage read may stall — so the transport cannot keep
 * running on a lease another process may already hold.
 */
function unknownAfterLostRace(
  runtime: OutboxRuntime,
  claim: ApplicationDeliveryClaim,
  reason: unknown,
): ValidatedOutcome {
  const deadlineWon = reason instanceof WaitBudgetElapsedError;
  const message = deadlineWon
    ? 'The attempt deadline passed while the transport call was in flight.'
    : 'The attempt was aborted while the transport call was in flight.';
  if (deadlineWon) {
    const registration = runtime.attemptControllers.get(claim.attemptToken);
    if (registration !== undefined && !registration.controller.signal.aborted) {
      registration.controller.abort(new Error(message));
    }
  }
  return { status: 'unknown', failure: { reason: 'unknown-outcome', message } };
}

function describeError(error: unknown): string {
  try {
    // An `Error` subclass may return anything from its `message` getter;
    // coerce inside the guard so a hostile value cannot escape as a second
    // exception from the template below.
    const message: unknown = error instanceof Error ? error.message : error;
    return typeof message === 'string' ? message : String(message);
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
  // A caller that aborted while the claim was committing — or a handle that
  // was disposed then, which aborts the claim's own signal — gets no send at
  // all: the lease is left to lapse in `claimed`, which maintenance
  // reschedules as a provably unsent attempt.
  if (options?.signal?.aborted === true || claim.signal.aborted || runtime.disposal.aborted) {
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
      receipt: await currentReceipt(runtime, deliveryId, begun, claim.receipt),
      committed: false,
    };
  }
  // The begin commit granted a fresh visibility window; renewal and the send
  // start from that, not from the claim's original expiry, which a slow begin
  // may already have outrun.
  const attempting: ApplicationDeliveryClaim = {
    ...claim,
    receipt: begun.receipt,
    visibilityExpiresAt: begun.receipt.visibilityExpiresAt ?? claim.visibilityExpiresAt,
  };
  return sendAndSettle(runtime, adapter, attempting, options?.signal);
}

/**
 * Run the adapter for a begun attempt — renewing the lease and forwarding
 * the caller's abort while it runs — then settle on what it reported, unless
 * the outbox was disposed mid-send.
 */
async function sendAndSettle(
  runtime: OutboxRuntime,
  adapter: ApplicationDeliveryAdapter,
  attempting: ApplicationDeliveryClaim,
  requestSignal: AbortSignal | undefined,
): Promise<ApplicationOutboxDeliverResult> {
  const deliveryId = attempting.receipt.deliveryId;
  const stopRenewing = keepLeaseAlive(runtime, attempting);
  const stopForwarding = forwardAbort(runtime, attempting.attemptToken, requestSignal);
  let outcome: ValidatedOutcome;
  try {
    outcome = await sendOnce(runtime, adapter, attempting, requestSignal);
  } finally {
    stopRenewing();
    stopForwarding();
  }
  // Disposal mid-send aborted the adapter; a caller that disposed the handle
  // may already have released the storage behind it, so nothing more is
  // written. The lease stays `attempting` for a maintenance pass to recover
  // as an unknown outcome, which is exactly what it is.
  if (runtime.disposal.aborted) {
    return { status: 'settled', receipt: attempting.receipt, committed: false };
  }
  const settled = await settleAttempt(runtime, {
    deliveryId,
    attemptToken: attempting.attemptToken,
    outcome,
  });
  releaseAttemptController(
    runtime,
    attempting.attemptToken,
    'The application outbox finished this attempt.',
    deliveryId,
  );
  return {
    status: 'settled',
    receipt: await currentReceipt(runtime, deliveryId, settled, attempting.receipt),
    committed: settled.status === 'settled' || settled.status === 'retrying',
  };
}

/** The configured adapter, or the caller-mistake diagnostic when there is none. */
export function requireAdapter(runtime: OutboxRuntime): ApplicationDeliveryAdapter {
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
    // The renewal itself is bounded by the confirmed window: a storage call
    // that hangs rather than rejects must not leave the adapter's signal live
    // past the expiry another process may already have recovered.
    const remaining = confirmedExpiresAt - runtime.now();
    if (remaining <= 0) {
      abort('The attempt lease expired before its renewal could be confirmed.');
      return;
    }
    const raced = await raceAbortWithin(
      () => heartbeatAttempt(runtime, { deliveryId, attemptToken: claim.attemptToken }),
      remaining,
    ).catch(() => null);
    if (stopped) return;
    if (raced === null) {
      // A storage failure during renewal is not a verdict on the lease; try
      // again while the last confirmed window still holds, and abort once it
      // cannot be confirmed before expiry.
      arm();
      return;
    }
    if (raced.aborted) {
      abort('The attempt lease expired before its renewal could be confirmed.');
      return;
    }
    const result = raced.value;
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

/**
 * The receipt a refused or settled step reports, re-read when the step carried
 * none. A record retired by retention in the meantime — another process
 * recovered and terminalized the attempt and a short retention window already
 * deleted the receipt — is an ordinary race, reported with the last receipt
 * this runner observed rather than as an error.
 */
async function currentReceipt(
  runtime: OutboxRuntime,
  deliveryId: string,
  result: { readonly status: string; readonly receipt?: ApplicationDeliveryReceipt },
  lastObserved: ApplicationDeliveryReceipt,
): Promise<ApplicationDeliveryReceipt> {
  if (result.receipt !== undefined) return result.receipt;
  const loaded = await loadDelivery(runtime.storage, runtime.keys, deliveryId);
  return loaded === null ? lastObserved : toApplicationDeliveryReceipt(loaded.record);
}

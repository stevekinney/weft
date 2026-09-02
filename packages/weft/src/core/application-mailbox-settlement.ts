/**
 * Attempt-fenced settlement for the application command mailbox (WFT-84):
 * lease renewal, acknowledgement, rejection, cancellation, and the bounded
 * cleanup wait.
 *
 * Every function here proves the caller holds the current attempt before it
 * writes anything, and every one re-reads durable state after a lost
 * compare-and-swap rather than retrying with stale bytes. A stale claimant
 * therefore cannot acknowledge, reject, cancel, extend, or heartbeat a newer
 * attempt — it gets a `stale` result carrying the authoritative receipt.
 *
 * Renewal is the one mutation that emits no fleet event. It is liveness
 * evidence, not a state transition: the record's disposition is unchanged, so
 * publishing an event per heartbeat would flood the feed without telling a
 * consumer anything a receipt read does not already say.
 *
 * @module core/application-mailbox-settlement
 */

import type {
  ApplicationCommandCancellationResult,
  ApplicationCommandCleanupResult,
  ApplicationCommandReceipt,
  ApplicationCommandRenewalResult,
  ApplicationCommandSettleResult,
  LoadedCommandRecord,
} from './application-mailbox-contract.ts';
import {
  ApplicationMailboxContentionError,
  commitCommandTransition,
  isTerminalRecord,
  MAX_MAILBOX_TRANSITION_ATTEMPTS,
  releaseAttemptController,
  toApplicationCommandReceipt,
  type MailboxRuntime,
} from './application-mailbox-internals.ts';
import {
  commitMailboxTransition,
  loadCommand,
  planCommandTransition,
} from './application-mailbox-storage.ts';
import { recoverExpiredCommand } from './application-mailbox-transitions-recovery.ts';
import {
  acknowledgeCommand,
  rejectCommand,
  renewCommandLease,
  requestCommandCancellation,
  type ApplicationMailboxTransition,
} from './application-mailbox-transitions.ts';
import type {
  ApplicationCommandAccepted,
  ApplicationCommandFailure,
  ApplicationCommandRecord,
  ApplicationCommandTerminalRecord,
} from './application-mailbox-types.ts';
import { isApplicationCommandLeased } from './application-mailbox-types.ts';
import type { JSONValue } from './json.ts';

/**
 * Extend a lease and report liveness for the current attempt.
 *
 * The returned `cancellationRequested` flag is the cross-process cancellation
 * channel. A claimant in another process never sees the attempt-scoped
 * `AbortSignal`, so renewal is where it learns that cancellation was requested.
 */
export async function renewClaim(
  runtime: MailboxRuntime,
  options: {
    readonly commandId: string;
    readonly attemptToken: string;
    readonly progress?: JSONValue | undefined;
  },
): Promise<ApplicationCommandRenewalResult> {
  for (let attempt = 1; attempt <= MAX_MAILBOX_TRANSITION_ATTEMPTS; attempt += 1) {
    const loaded = await loadCommand(runtime.storage, runtime.keys, options.commandId);
    if (loaded === null) return { status: 'unknown' };
    // Read the clock AFTER the load. The read is asynchronous, so a renewal that
    // began just inside the deadline can cross it during the read; deciding on
    // the earlier reading would extend a lease the contract says is over.
    const now = runtime.now();
    const transition = renewCommandLease(loaded.record, {
      attemptToken: options.attemptToken,
      now,
      progress: options.progress,
    });
    if (!transition.ok) {
      return {
        status: transition.reason === 'deadline-exceeded' ? 'deadline-exceeded' : 'stale',
        receipt: toApplicationCommandReceipt(loaded.record),
      };
    }
    const committed = await commitMailboxTransition(runtime.storage, runtime.events, {
      ...planCommandTransition(runtime.keys, {
        previous: loaded.record,
        expectedBytes: loaded.bytes,
        next: transition.next,
        event: null,
        now,
      }),
    });
    if (!committed) continue;
    return {
      status: 'renewed',
      visibilityExpiresAt: transition.next.visibilityExpiresAt,
      cancellationRequested: transition.next.state === 'cancellation-requested',
      receipt: toApplicationCommandReceipt(transition.next),
    };
  }
  throw new ApplicationMailboxContentionError('renew', options.commandId);
}

/** Settle a claimed command successfully. */
export async function acknowledgeClaim(
  runtime: MailboxRuntime,
  options: {
    readonly commandId: string;
    readonly attemptToken: string;
    readonly outcome?: JSONValue | undefined;
  },
): Promise<ApplicationCommandSettleResult> {
  return settle(runtime, options.commandId, 'acknowledge', (record, now) =>
    acknowledgeCommand(record, {
      attemptToken: options.attemptToken,
      now,
      outcome: options.outcome,
    }),
  );
}

/**
 * Settle a claimed command as failed, optionally scheduling a retry at the
 * command's original FIFO position.
 */
export async function rejectClaim(
  runtime: MailboxRuntime,
  options: {
    readonly commandId: string;
    readonly attemptToken: string;
    readonly failure: ApplicationCommandFailure;
    readonly retry: boolean;
  },
): Promise<ApplicationCommandSettleResult> {
  return settle(runtime, options.commandId, 'reject', (record, now) =>
    rejectCommand(record, {
      attemptToken: options.attemptToken,
      now,
      retry: options.retry,
      failure: options.failure,
      retryBackoffMs: runtime.policy.retryBackoffMs,
      maxRetryBackoffMs: runtime.policy.maxRetryBackoffMs,
    }),
  );
}

/**
 * The shared shape of `acknowledgeCommand` and `rejectCommand`: decide the next
 * record from the current one, or say why the edge is illegal.
 */
type SettlementDecision = (
  record: ApplicationCommandRecord,
  now: number,
) => ApplicationMailboxTransition<ApplicationCommandAccepted | ApplicationCommandTerminalRecord>;

async function settle(
  runtime: MailboxRuntime,
  commandId: string,
  operation: string,
  decide: SettlementDecision,
): Promise<ApplicationCommandSettleResult> {
  for (let attempt = 1; attempt <= MAX_MAILBOX_TRANSITION_ATTEMPTS; attempt += 1) {
    const loaded = await loadCommand(runtime.storage, runtime.keys, commandId);
    if (loaded === null) return { status: 'unknown' };
    // Fresh clock after the asynchronous load, for the same reason as renewal.
    const now = runtime.now();
    const transition = decide(loaded.record, now);
    if (!transition.ok) {
      return {
        status: transition.reason === 'deadline-exceeded' ? 'deadline-exceeded' : 'stale',
        receipt: toApplicationCommandReceipt(loaded.record),
      };
    }
    const committed = await commitCommandTransition(runtime, {
      previous: loaded.record,
      expectedBytes: loaded.bytes,
      next: transition.next,
      now,
    });
    if (!committed) continue;
    if (isApplicationCommandLeased(loaded.record)) {
      releaseAttemptController(
        runtime,
        loaded.record.attemptToken,
        'The application mailbox released this attempt when the command settled.',
      );
    }
    return {
      status: isTerminalRecord(transition.next) ? 'settled' : 'retrying',
      receipt: toApplicationCommandReceipt(transition.next),
    };
  }
  throw new ApplicationMailboxContentionError(operation, commandId);
}

/**
 * Record a durable cancellation request and, when the claimant is in this
 * process, abort its attempt-scoped signal.
 *
 * Cancellation is durable before any acknowledgement: the abort fires only
 * after the record commits, so a crash between the two cannot leave a claimant
 * aborted without the request being persisted.
 */
export async function requestCancellation(
  runtime: MailboxRuntime,
  options: {
    readonly commandId: string;
    readonly reason?: string | undefined;
  },
): Promise<ApplicationCommandCancellationResult> {
  for (let attempt = 1; attempt <= MAX_MAILBOX_TRANSITION_ATTEMPTS; attempt += 1) {
    const loaded = await loadCommand(runtime.storage, runtime.keys, options.commandId);
    if (loaded === null) return { status: 'unknown' };
    const now = runtime.now();
    const transition = requestCommandCancellation(loaded.record, { now, reason: options.reason });
    if (!transition.ok) {
      // Past the deadline the command must become terminal NOW, not whenever
      // maintenance next runs. Reporting `already-terminal` while the record is
      // still `claimed` would leave a live lease — and an un-aborted local signal
      // — behind a receipt that claims the command is over.
      if (transition.reason === 'deadline-exceeded') {
        const expired = await deadLetterExpired(runtime, loaded, now);
        if (expired === null) continue;
        return { status: 'already-terminal', receipt: expired };
      }
      // The transition is the single decision point, so both illegal edges are
      // classified here rather than pre-checked twice. `not-leased` against a
      // record already in `cancellation-requested` is the idempotent repeat: the
      // request stands and the same attempt still owns cleanup, so re-abort (a
      // no-op when already aborted) and report what the first call reported.
      if (transition.reason === 'not-leased' && isApplicationCommandLeased(loaded.record)) {
        abortLocalClaimant(runtime, loaded.record.attemptToken);
        return {
          status: 'requested',
          receipt: toApplicationCommandReceipt(loaded.record),
          cleanupPending: true,
        };
      }
      return { status: 'already-terminal', receipt: toApplicationCommandReceipt(loaded.record) };
    }
    const committed = await commitCommandTransition(runtime, {
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
        receipt: toApplicationCommandReceipt(transition.next),
        cleanupPending: true,
      };
    }
    return { status: 'cancelled', receipt: toApplicationCommandReceipt(transition.next) };
  }
  throw new ApplicationMailboxContentionError('cancel', options.commandId);
}

/**
 * Dead-letter a command found past its absolute deadline, releasing any local
 * attempt it still held. Returns `null` when the compare-and-swap lost, so the
 * caller re-reads rather than reporting a disposition it did not observe.
 */
async function deadLetterExpired(
  runtime: MailboxRuntime,
  loaded: LoadedCommandRecord,
  now: number,
): Promise<ApplicationCommandReceipt | null> {
  const transition = recoverExpiredCommand(loaded.record, {
    now,
    retryBackoffMs: runtime.policy.retryBackoffMs,
    maxRetryBackoffMs: runtime.policy.maxRetryBackoffMs,
  });
  if (!transition.ok) return null;
  const committed = await commitCommandTransition(runtime, {
    previous: loaded.record,
    expectedBytes: loaded.bytes,
    next: transition.next,
    now,
  });
  if (!committed) return null;
  if (isApplicationCommandLeased(loaded.record)) {
    releaseAttemptController(
      runtime,
      loaded.record.attemptToken,
      'The application mailbox dead-lettered this command at its absolute deadline.',
    );
  }
  return toApplicationCommandReceipt(transition.next);
}

function abortLocalClaimant(runtime: MailboxRuntime, attemptToken: string): void {
  const registration = runtime.attemptControllers.get(attemptToken);
  if (registration !== undefined && !registration.controller.signal.aborted) {
    registration.controller.abort(new Error('The application mailbox cancelled this command.'));
  }
}

/**
 * Read whether a cancelled command's claimant has finished.
 *
 * `pending` means the mailbox has not seen the attempt settle. It never claims
 * the handler stopped — only that cleanup is still outstanding.
 */
export async function readCleanupState(
  runtime: MailboxRuntime,
  commandId: string,
): Promise<ApplicationCommandCleanupResult> {
  const loaded = await loadCommand(runtime.storage, runtime.keys, commandId);
  if (loaded === null) return { status: 'unknown' };
  const receipt = toApplicationCommandReceipt(loaded.record);
  // `receipt.cleanupPending` is already the projected, narrowed view: it is
  // defined only on a terminal record, so reading it here needs no re-narrowing.
  if (receipt.terminalAt !== undefined && receipt.cleanupPending !== true) {
    return { status: 'settled', receipt };
  }
  return { status: 'pending', receipt };
}

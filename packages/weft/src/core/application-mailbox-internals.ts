/**
 * Shared runtime context and projections for the application command mailbox
 * (WFT-84).
 *
 * The public class and the maintenance pass both need the same bound storage
 * keys, resolved policy, clock, commit path, and attempt-controller registry.
 * Passing that context explicitly — rather than reaching into the class — keeps
 * `application-mailbox-maintenance.ts` a set of ordinary functions that tests
 * can drive directly.
 *
 * @module core/application-mailbox-internals
 */

import type { BatchOperation, ConditionalBatchCondition, Storage } from '../storage/interface.ts';
import type {
  ApplicationCommandReceipt,
  ApplicationMailboxEventSink,
} from './application-mailbox-contract.ts';
import {
  commitMailboxTransition,
  headerOperation,
  loadMailboxHeader,
  planCommandTransition,
  type MailboxKeys,
} from './application-mailbox-storage.ts';
import type {
  ApplicationCommandRecord,
  ApplicationCommandTerminalRecord,
} from './application-mailbox-types.ts';
import { isApplicationCommandLeased } from './application-mailbox-types.ts';
import type { ResolvedMailboxPolicy } from './application-mailbox-validation.ts';
import { WeftError } from './weft-error.ts';

/**
 * How many times a transition re-reads durable state and retries after losing a
 * compare-and-swap.
 *
 * The mailbox header is deliberately a per-mailbox hot key — admission and every
 * terminal transition both touch it, which is what makes backlog accounting
 * exact — so a busy mailbox does see contention. The ceiling exists so a
 * pathological loop surfaces as an error instead of spinning forever.
 */
export const MAX_MAILBOX_TRANSITION_ATTEMPTS = 25;

/**
 * How many scan pages one maintenance pass may walk.
 *
 * The pass reaches the whole keyspace by paging, but stops after this many pages
 * so a very large mailbox cannot make one call run unboundedly. The next pass
 * starts again from the beginning and picks up whatever is still due.
 */
export const MAILBOX_MAINTENANCE_MAX_PAGES = 200;

/** Everything a mailbox operation needs that is fixed at construction. */
export type MailboxRuntime = {
  readonly storage: Storage;
  readonly events: ApplicationMailboxEventSink | undefined;
  readonly policy: ResolvedMailboxPolicy;
  readonly keys: MailboxKeys;
  readonly now: () => number;
  readonly generateId: () => string;
  /**
   * Abort controllers for attempts claimed in this process, keyed by attempt
   * token — shared across every handle onto the same mailbox, so a cancellation
   * raised through one handle reaches a claimant holding another.
   */
  readonly attemptControllers: Map<string, AttemptRegistration>;
  /**
   * Record an attempt this handle now owns, or report that disposal already won.
   *
   * Registering ownership in the caller's `await` continuation would race
   * disposal: `dispose()` could run between the claim resolving and the token
   * being recorded, see nothing to abort, and leave a live claim from a disposed
   * mailbox. Doing both under one synchronous call closes that window.
   */
  readonly adoptAttempt: (attemptToken: string) => (() => void) | null;
  /**
   * Where the previous maintenance pass stopped, when its page cap cut it short.
   *
   * Process-local rather than durable: it is an optimisation for walking a very
   * large keyspace across successive calls, and losing it on restart only means
   * the next pass starts from the beginning, which is always correct.
   */
  readonly readMaintenanceCursor: () => string | undefined;
  readonly writeMaintenanceCursor: (cursor: string | undefined) => void;
};

/**
 * Attempt controllers, shared per `(storage, namespace, resourceId)` within one
 * process.
 *
 * Two `ApplicationMailbox` handles onto the same durable mailbox are the same
 * mailbox. Giving each its own registry would make the documented in-process
 * cancellation channel silently fail whenever the claimant and the canceller
 * held different handles — the claimant's signal would never fire and it would
 * learn about cancellation only through renewal, which is supposed to be the
 * *cross-process* fallback. Keyed by `Storage` identity in a `WeakMap` so a
 * discarded backend takes its registries with it.
 */
/**
 * One live attempt in this process: its abort controller plus the callback that
 * forgets it from the handle that claimed it.
 *
 * Carrying the release alongside the controller is what lets a *sibling* handle
 * — one running maintenance, or settling with a token it was handed — release
 * ownership from the handle that actually owns it. Without that, the claiming
 * handle's ownership set leaks one entry per attempt settled elsewhere.
 */
export type AttemptRegistration = {
  readonly controller: AbortController;
  readonly release: () => void;
};

/**
 * One mailbox scope's live attempts plus the number of handles currently
 * holding it, so the scope can be dropped once nothing references it.
 */
type ScopeRegistry = {
  readonly controllers: Map<string, AttemptRegistration>;
  handles: number;
};

const ATTEMPT_CONTROLLERS_BY_STORAGE = new WeakMap<Storage, Map<string, ScopeRegistry>>();

function scopeKey(namespace: string, resourceId: string): string {
  return `${encodeURIComponent(namespace)}:${encodeURIComponent(resourceId)}`;
}

/**
 * Acquire the shared attempt-controller registry for one mailbox scope in this
 * process. Every acquisition is balanced by `releaseAttemptControllerRegistry`
 * from the handle's `dispose()`.
 */
export function attemptControllerRegistry(
  storage: Storage,
  namespace: string,
  resourceId: string,
): Map<string, AttemptRegistration> {
  let byScope = ATTEMPT_CONTROLLERS_BY_STORAGE.get(storage);
  if (byScope === undefined) {
    byScope = new Map();
    ATTEMPT_CONTROLLERS_BY_STORAGE.set(storage, byScope);
  }
  const scope = scopeKey(namespace, resourceId);
  let entry = byScope.get(scope);
  if (entry === undefined) {
    entry = { controllers: new Map(), handles: 0 };
    byScope.set(scope, entry);
  }
  entry.handles += 1;
  return entry.controllers;
}

/**
 * Release one handle's hold on a scope registry.
 *
 * The scope is forgotten once no handle holds it and no attempt is live in it.
 * A service that creates short-lived mailboxes for many resource ids over one
 * long-lived storage would otherwise retain a map per historical resource.
 * A live attempt owned by a sibling handle keeps the scope until it settles.
 */
export function releaseAttemptControllerRegistry(
  storage: Storage,
  namespace: string,
  resourceId: string,
): void {
  const byScope = ATTEMPT_CONTROLLERS_BY_STORAGE.get(storage);
  const scope = scopeKey(namespace, resourceId);
  const entry = byScope?.get(scope);
  if (byScope === undefined || entry === undefined) return;
  entry.handles = Math.max(0, entry.handles - 1);
  if (entry.handles === 0 && entry.controllers.size === 0) byScope.delete(scope);
}

/** Whether this process still tracks a registry for the scope. Diagnostics and tests. */
export function hasAttemptControllerScope(
  storage: Storage,
  namespace: string,
  resourceId: string,
): boolean {
  return ATTEMPT_CONTROLLERS_BY_STORAGE.get(storage)?.has(scopeKey(namespace, resourceId)) === true;
}

/**
 * Thrown when a transition keeps losing its compare-and-swap.
 *
 * Surfacing this beats looping forever: it means durable contention on this
 * mailbox is real, and the caller — not a hidden retry loop — decides whether to
 * back off, shed load, or shard the resource.
 *
 * @example
 * ```ts
 * import { ApplicationMailboxContentionError } from '@lostgradient/weft';
 *
 * const error = new ApplicationMailboxContentionError('admit', null);
 * console.log(error.code); // 'ApplicationMailboxContentionError'
 * ```
 */
export class ApplicationMailboxContentionError extends WeftError<'ApplicationMailboxContentionError'> {
  /** The mailbox operation that could not commit. */
  readonly operation: string;
  /** The command the operation targeted, or `null` for mailbox-wide operations. */
  readonly commandId: string | null;

  constructor(operation: string, commandId: string | null) {
    super(
      'ApplicationMailboxContentionError',
      `Application mailbox ${operation}${commandId === null ? '' : ` for command "${commandId}"`} lost its storage precondition after ${MAX_MAILBOX_TRANSITION_ATTEMPTS} attempts.`,
    );
    this.operation = operation;
    this.commandId = commandId;
  }
}

/**
 * Project a durable record into the immutable public receipt.
 *
 * Every observer gets its own frozen object, so sharing a receipt cannot let one
 * observer mutate another's view, and reading one never touches durable state.
 */
/** The lease-liveness half of a receipt, empty unless an attempt holds the command. */
function receiptLeaseFields(record: ApplicationCommandRecord) {
  if (!isApplicationCommandLeased(record)) return {};
  return {
    claimedAt: record.claimedAt,
    visibilityExpiresAt: record.visibilityExpiresAt,
    lastActivityAt: record.lastActivityAt,
    progress: record.progress,
  };
}

/** The terminal-evidence half of a receipt, empty unless the command has settled. */
function receiptTerminalFields(record: ApplicationCommandRecord) {
  if (!isTerminalRecord(record)) {
    return record.state === 'cancellation-requested'
      ? {
          cancellationRequestedAt: record.cancellationRequestedAt,
          cancellationReason: record.cancellationReason,
        }
      : {};
  }
  return {
    cancellationRequestedAt: record.cancellationRequestedAt,
    cancellationReason: record.cancellationReason,
    terminalAt: record.terminalAt,
    outcome: record.outcome,
    failure: record.failure,
    cleanupPending: record.cleanupPending,
  };
}

/**
 * Recursively freeze a value reached from a receipt.
 *
 * `Object.freeze` is shallow, so freezing only the receipt would leave
 * `causation`, `progress`, `outcome`, and `failure.details` mutable — and every
 * observer shares those references. One consumer could then change what another
 * sees through a receipt documented as immutable.
 */
function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

export function toApplicationCommandReceipt(
  record: ApplicationCommandRecord,
): ApplicationCommandReceipt {
  return deepFreeze({
    commandId: record.commandId,
    namespace: record.namespace,
    resourceId: record.resourceId,
    sequence: record.sequence,
    state: record.state,
    caller: record.caller,
    target: record.target,
    kind: record.kind,
    payloadDigest: record.payloadDigest,
    payloadForm: record.payload.form,
    payloadMediaType: record.payloadMediaType,
    payloadSchema: record.payloadSchema,
    idempotencyKey: record.idempotencyKey,
    causation: record.causation,
    acceptedAt: record.acceptedAt,
    availableAt: record.availableAt,
    absoluteDeadlineAt: record.absoluteDeadlineAt,
    attempt: record.attempt,
    retryCount: record.retryCount,
    maxAttempts: record.maxAttempts,
    generation: record.generation,
    ...receiptLeaseFields(record),
    ...receiptTerminalFields(record),
  });
}

const STATE_EVENT_KINDS: Readonly<Record<ApplicationCommandRecord['state'], string>> = {
  accepted: 'mailbox:command-accepted',
  available: 'mailbox:command-available',
  claimed: 'mailbox:command-claimed',
  'cancellation-requested': 'mailbox:command-cancellation-requested',
  applied: 'mailbox:command-applied',
  rejected: 'mailbox:command-rejected',
  cancelled: 'mailbox:command-cancelled',
  'dead-lettered': 'mailbox:command-dead-lettered',
};

/**
 * The durable fleet event that describes a transition.
 *
 * A retry is distinguished from an initial admission even though both land in
 * `accepted`, so a consumer reading the feed can tell redelivery from first
 * delivery without diffing receipts. The payload is deliberately bounded: no
 * command payload, no failure details, nothing unbounded.
 */
export function describeCommandTransition(
  previous: ApplicationCommandRecord | null,
  next: ApplicationCommandRecord,
): { readonly kind: string; readonly payload: unknown } {
  const retried =
    previous !== null && next.state === 'accepted' && next.retryCount > previous.retryCount;
  return {
    kind: retried ? 'mailbox:command-retry-scheduled' : STATE_EVENT_KINDS[next.state],
    payload: {
      namespace: next.namespace,
      resourceId: next.resourceId,
      commandId: next.commandId,
      sequence: next.sequence,
      state: next.state,
      commandKind: next.kind,
      target: next.target,
      attempt: next.attempt,
      retryCount: next.retryCount,
      generation: next.generation,
      previousState: previous === null ? null : previous.state,
    },
  };
}

/**
 * Abort and forget the process-local controller for one attempt.
 *
 * Releasing a lease must never leave a live controller behind: the signal is
 * attempt-scoped, so a later attempt on the same command gets a fresh one.
 */
export function releaseAttemptController(
  runtime: MailboxRuntime,
  attemptToken: string,
  reason: string,
): void {
  const registration = runtime.attemptControllers.get(attemptToken);
  if (registration === undefined) return;
  runtime.attemptControllers.delete(attemptToken);
  // Release through the registration, so the handle that CLAIMED the attempt
  // forgets it even when a sibling handle is the one settling or reclaiming.
  registration.release();
  if (!registration.controller.signal.aborted) registration.controller.abort(new Error(reason));
}

/**
 * Commit one command transition together with the index maintenance and
 * backlog accounting it implies.
 *
 * Terminalizing a command decrements the mailbox's open count in the same
 * conditional batch, so `capacity()` can never drift from the records it
 * describes. Admission is the one transition that builds its own header
 * operation, because it also allocates the FIFO sequence.
 *
 * Returns `false` when a compare-and-swap was lost; the caller re-reads and
 * re-decides rather than retrying blindly with stale bytes.
 */
export async function commitCommandTransition(
  runtime: MailboxRuntime,
  options: {
    readonly previous: ApplicationCommandRecord | null;
    readonly expectedBytes: Uint8Array | null;
    readonly next: ApplicationCommandRecord;
    readonly now: number;
    readonly extraConditions?: readonly ConditionalBatchCondition[] | undefined;
    readonly extraOperations?: readonly BatchOperation[] | undefined;
  },
): Promise<boolean> {
  const closing =
    options.previous !== null &&
    !isTerminalRecord(options.previous) &&
    isTerminalRecord(options.next);
  const extraConditions = [...(options.extraConditions ?? [])];
  const extraOperations = [...(options.extraOperations ?? [])];
  if (closing) {
    const header = await loadMailboxHeader(
      runtime.storage,
      runtime.keys,
      runtime.policy.namespace,
      runtime.policy.resourceId,
    );
    extraConditions.push({ key: runtime.keys.header, expectedValue: header.bytes });
    extraOperations.push(
      headerOperation(runtime.keys, {
        ...header.record,
        openCount: Math.max(0, header.record.openCount - 1),
      }),
    );
  }
  return commitMailboxTransition(
    runtime.storage,
    runtime.events,
    planCommandTransition(runtime.keys, {
      previous: options.previous,
      expectedBytes: options.expectedBytes,
      next: options.next,
      event: describeCommandTransition(options.previous, options.next),
      now: options.now,
      extraConditions,
      extraOperations,
    }),
  );
}

/** Whether a record occupies one of the four terminal dispositions. */
export function isTerminalRecord(
  record: ApplicationCommandRecord,
): record is ApplicationCommandTerminalRecord {
  return (
    record.state === 'applied' ||
    record.state === 'rejected' ||
    record.state === 'cancelled' ||
    record.state === 'dead-lettered'
  );
}

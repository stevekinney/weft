/**
 * Shared runtime plumbing for the application delivery outbox (WFT-85): the
 * per-instance runtime, the contention error, receipt projection, fleet event
 * description, process-local attempt release, and the commit that keeps the
 * header's backlog accounting consistent with every transition.
 *
 * @module core/outbox-internals
 */

import type { BatchOperation, ConditionalBatchCondition, Storage } from '../storage/interface.ts';
import type { AttemptRegistry } from './application-primitive-attempt-registry.ts';
import type {
  ApplicationDeliveryAdapter,
  ApplicationDeliveryReceipt,
  OutboxEventSink,
} from './outbox-contract.ts';
import {
  commitOutboxTransition,
  headerOperation,
  loadOutboxHeader,
  planDeliveryTransition,
  type LoadedOutboxRecord,
  type OutboxKeys,
} from './outbox-storage.ts';
import { isTerminalDeliveryRecord } from './outbox-transition-helpers.ts';
import { isApplicationDeliveryLeased, type ApplicationDeliveryRecord } from './outbox-types.ts';
import type { ResolvedOutboxPolicy } from './outbox-validation.ts';
import { WeftError } from './weft-error.ts';

/** How many times one operation re-reads and retries a lost compare-and-swap. */
export const MAX_OUTBOX_TRANSITION_ATTEMPTS = 25;

/** How many scan pages one maintenance pass may walk. */
export const OUTBOX_MAINTENANCE_MAX_PAGES = 200;

/** The registry-scope tag for the outbox, so it never shares a registry with the mailbox. */
export const OUTBOX_PRIMITIVE = 'outbox';

/** Everything an outbox operation needs that is fixed at construction. */
export type OutboxRuntime = {
  readonly storage: Storage;
  readonly events: OutboxEventSink | undefined;
  readonly adapter: ApplicationDeliveryAdapter | undefined;
  readonly policy: ResolvedOutboxPolicy;
  readonly keys: OutboxKeys;
  readonly now: () => number;
  readonly generateId: () => string;
  /** The process-local disposal signal every wait and attempt races. */
  readonly disposal: AbortSignal;
  readonly attemptControllers: AttemptRegistry;
  /** Record an attempt this handle now owns, or report that disposal already won. */
  readonly adoptAttempt: (attemptToken: string) => (() => void) | null;
  readonly readMaintenanceCursor: () => string | undefined;
  readonly writeMaintenanceCursor: (cursor: string | undefined) => void;
};

/**
 * Thrown when a transition keeps losing its compare-and-swap: durable
 * contention on this outbox is real, and the caller decides whether to back
 * off, shed load, or shard the owner.
 *
 * @example
 * ```ts
 * import { OutboxContentionError } from '@lostgradient/weft';
 *
 * const error = new OutboxContentionError('enqueue', null);
 * console.log(error.code); // 'OutboxContentionError'
 * ```
 */
export class OutboxContentionError extends WeftError<'OutboxContentionError'> {
  /** The outbox operation that could not commit. */
  readonly operation: string;
  /** The delivery the operation targeted, or `null` for outbox-wide operations. */
  readonly deliveryId: string | null;

  constructor(operation: string, deliveryId: string | null) {
    super(
      'OutboxContentionError',
      `Application outbox ${operation}${deliveryId === null ? '' : ` for delivery "${deliveryId}"`} lost its storage precondition after ${MAX_OUTBOX_TRANSITION_ATTEMPTS} attempts.`,
    );
    this.operation = operation;
    this.deliveryId = deliveryId;
  }
}

function receiptLeaseFields(record: ApplicationDeliveryRecord) {
  if (!isApplicationDeliveryLeased(record)) return {};
  return {
    claimedAt: record.claimedAt,
    visibilityExpiresAt: record.visibilityExpiresAt,
    attemptDeadlineAt: record.attemptDeadlineAt,
    lastActivityAt: record.lastActivityAt,
    transportActivity: record.transportActivity,
    ...(record.state === 'claimed' ? {} : { attemptStartedAt: record.attemptStartedAt }),
    ...(record.state === 'cancellation-requested'
      ? {
          cancellationRequestedAt: record.cancellationRequestedAt,
          cancellationReason: record.cancellationReason,
        }
      : {}),
  };
}

function receiptTerminalFields(record: ApplicationDeliveryRecord) {
  if (record.state === 'retry-scheduled') return { lastFailure: record.lastFailure };
  if (!isTerminalDeliveryRecord(record)) return {};
  return {
    cancellationRequestedAt: record.cancellationRequestedAt,
    cancellationReason: record.cancellationReason,
    terminalAt: record.terminalAt,
    evidence: record.evidence,
    failure: record.failure,
    cleanupPending: record.cleanupPending,
  };
}

/** Recursively freeze a value reached from a receipt, so observers cannot mutate each other's view. */
function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

/**
 * Project a durable record into the immutable public receipt. The attempt
 * token and the credential reference are never projected.
 */
export function toApplicationDeliveryReceipt(
  record: ApplicationDeliveryRecord,
): ApplicationDeliveryReceipt {
  return deepFreeze({
    deliveryId: record.deliveryId,
    namespace: record.namespace,
    ownerId: record.ownerId,
    sequence: record.sequence,
    state: record.state,
    destinationRef: record.destinationRef,
    kind: record.kind,
    payloadDigest: record.payloadDigest,
    payloadForm: record.payload.form,
    payloadMediaType: record.payloadMediaType,
    payloadSchema: record.payloadSchema,
    idempotencyKey: record.idempotencyKey,
    externalIdempotencyKey: record.externalIdempotencyKey,
    unknownOutcomePolicy: record.unknownOutcomePolicy,
    causation: record.causation,
    enqueuedAt: record.enqueuedAt,
    availableAt: record.availableAt,
    attempt: record.attempt,
    retryCount: record.retryCount,
    maxAttempts: record.maxAttempts,
    generation: record.generation,
    ...receiptLeaseFields(record),
    ...receiptTerminalFields(record),
  });
}

const STATE_EVENT_KINDS: Readonly<Record<ApplicationDeliveryRecord['state'], string>> = {
  queued: 'outbox:delivery-queued',
  'retry-scheduled': 'outbox:delivery-retry-scheduled',
  claimed: 'outbox:delivery-claimed',
  attempting: 'outbox:delivery-attempting',
  'cancellation-requested': 'outbox:delivery-cancellation-requested',
  acknowledged: 'outbox:delivery-acknowledged',
  rejected: 'outbox:delivery-rejected',
  cancelled: 'outbox:delivery-cancelled',
  'unknown-outcome': 'outbox:delivery-unknown-outcome',
  'dead-lettered': 'outbox:delivery-dead-lettered',
};

/**
 * The durable fleet event that describes a transition. Bounded and free of
 * secrets: no payload, no evidence, no failure details, and neither the
 * destination nor the credential reference.
 */
export function describeDeliveryTransition(
  previous: ApplicationDeliveryRecord | null,
  next: ApplicationDeliveryRecord,
): { readonly kind: string; readonly payload: unknown } {
  const operatorRetry =
    previous !== null && isTerminalDeliveryRecord(previous) && next.state === 'queued';
  return {
    kind: operatorRetry ? 'outbox:delivery-retried' : STATE_EVENT_KINDS[next.state],
    payload: {
      namespace: next.namespace,
      ownerId: next.ownerId,
      deliveryId: next.deliveryId,
      sequence: next.sequence,
      state: next.state,
      deliveryKind: next.kind,
      attempt: next.attempt,
      retryCount: next.retryCount,
      generation: next.generation,
      previousState: previous === null ? null : previous.state,
    },
  };
}

/** Abort and forget the process-local controller for one attempt. */
export function releaseAttemptController(
  runtime: OutboxRuntime,
  attemptToken: string,
  reason: string,
  deliveryId?: string,
): void {
  const registration = runtime.attemptControllers.get(attemptToken);
  if (registration === undefined) return;
  if (deliveryId !== undefined && registration.subjectId !== deliveryId) return;
  runtime.attemptControllers.delete(attemptToken);
  registration.release();
  if (!registration.controller.signal.aborted) registration.controller.abort(new Error(reason));
}

/**
 * Release every attempt this process holds for one delivery that is not its
 * current lease, fenced by the lease-commit serial the snapshot was read at.
 */
export function releaseAttemptsForDelivery(
  runtime: OutboxRuntime,
  deliveryId: string,
  reason: string,
  currentToken?: string,
  observedAt?: number,
): void {
  for (const attemptToken of runtime.attemptControllers.tokensFor(deliveryId)) {
    const registration = runtime.attemptControllers.get(attemptToken);
    if (registration === undefined || attemptToken === currentToken) continue;
    if (registration.committedSerial === null) continue;
    if (observedAt !== undefined && registration.committedSerial > observedAt) continue;
    releaseAttemptController(runtime, attemptToken, reason);
  }
}

/**
 * Commit one delivery transition together with the index maintenance and
 * backlog accounting it implies.
 *
 * Closing a delivery decrements the header's open count and an operator
 * retry that reopens one increments it, each in the same conditional batch as
 * the record, so `capacity()` can never drift from the records it describes.
 * Enqueue builds its own header operation because it also allocates the
 * sequence.
 */
export async function commitDeliveryTransition(
  runtime: OutboxRuntime,
  options: {
    readonly previous: ApplicationDeliveryRecord | null;
    readonly expectedBytes: Uint8Array | null;
    readonly next: ApplicationDeliveryRecord;
    readonly now: number;
    readonly extraConditions?: readonly ConditionalBatchCondition[] | undefined;
    readonly extraOperations?: readonly BatchOperation[] | undefined;
    /** A header the caller already read and decided on; the commit fences on these bytes. */
    readonly header?: LoadedOutboxRecord | undefined;
  },
): Promise<boolean> {
  const previousTerminal = options.previous !== null && isTerminalDeliveryRecord(options.previous);
  const nextTerminal = isTerminalDeliveryRecord(options.next);
  const delta = options.previous === null ? 0 : Number(previousTerminal) - Number(nextTerminal);
  const extraConditions = [...(options.extraConditions ?? [])];
  const extraOperations = [...(options.extraOperations ?? [])];
  if (delta !== 0) {
    const header =
      options.header ??
      (await loadOutboxHeader(
        runtime.storage,
        runtime.keys,
        runtime.policy.namespace,
        runtime.policy.ownerId,
      ));
    // The header read is an await of its own; a disposal that landed during
    // it must stop the write here, since the caller's own guard ran before
    // the read. Callers treat `false` as a lost compare-and-swap and re-read,
    // where their disposal guard ends the loop.
    if (runtime.disposal.aborted) return false;
    extraConditions.push({ key: runtime.keys.header, expectedValue: header.bytes });
    extraOperations.push(
      headerOperation(runtime.keys, {
        ...header.record,
        openCount: Math.max(0, header.record.openCount + delta),
      }),
    );
  }
  return commitOutboxTransition(
    runtime.storage,
    runtime.events,
    planDeliveryTransition(runtime.keys, {
      previous: options.previous,
      expectedBytes: options.expectedBytes,
      next: options.next,
      event: describeDeliveryTransition(options.previous, options.next),
      now: options.now,
      extraConditions,
      extraOperations,
    }),
  );
}

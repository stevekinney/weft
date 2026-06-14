import type { BatchOperation } from '../../storage/interface.ts';
import {
  KEYS,
  encodeStorageKeyComponent,
  requireStorageCapability,
  storageConditionalBatch,
} from '../../storage/interface.ts';
import { decode, encode } from '../codec.ts';
import { SignalReceivedEvent } from '../events.ts';
import type { ComposedWorkflowInterceptor } from '../interceptor.ts';
import { encodePayloadWithinLimit } from '../payload-size.ts';
import { validateSignalId } from '../signal-id.ts';
import type { SignalDeliveryOptions, WorkflowState } from '../types.ts';
import { commitAnonymousSignalOperations } from './anonymous-signal-sequence.ts';
import { stageAtomicWorkflowCommitSideEffects } from './checkpoint-side-effects.ts';
import type { EngineInternals } from './internals.ts';
import { isTerminalWorkflowStatus } from './validation.ts';

type TrackedWaiterKeys = string | Set<string>;

export type SignalCallbacks = {
  loadWorkflowState: (workflowId: string) => Promise<WorkflowState | null | undefined>;
  dispatchEvent: (event: Event) => boolean;
  broadcast: (message: { type: 'signal:received'; workflowId: string; signalName: string }) => void;
  getComposedInterceptor: () => ComposedWorkflowInterceptor | null | undefined;
  resumeParkedInlineWorkflow: (workflowId: string) => Promise<void>;
};

export type BufferedSignalOptions = {
  emitPublicEvent?: boolean;
  signalId?: string;
};

export type BufferedSignalDelivery = {
  signalName: string;
  payload: unknown;
  options?: BufferedSignalOptions;
};

export type ConsumedSignalResult =
  | { found: false }
  | {
      found: true;
      payload: unknown;
    };

const EMPTY_STORAGE_VALUE = new Uint8Array(0);
const SIGNAL_ACCEPTED_RESPONSE = { ok: true } as const;
const SIGNAL_KEY_COMPONENT_COUNT = 5;

type BufferedSignalRecord = {
  key: string;
  value: Uint8Array;
};

export async function signal(
  internals: EngineInternals,
  workflowId: string,
  name: string,
  payload: unknown,
  callbacks: SignalCallbacks,
  options: SignalDeliveryOptions = {},
): Promise<void> {
  const deliverSignal = async (
    targetWorkflowId: string,
    signalName: string,
    signalPayload: unknown,
  ): Promise<void> => {
    await bufferSignalPayloads(
      internals,
      targetWorkflowId,
      [{ signalName, payload: signalPayload }],
      callbacks,
      options,
    );
  };

  // Run signalReceived interceptor hook wrapping actual delivery
  const composed = callbacks.getComposedInterceptor();
  if (composed) {
    let deliveryPromise: Promise<void> | undefined;
    let nextCalled = false;
    try {
      composed.signalReceived(
        {
          workflowId,
          signalName: name,
          payload: payload,
          headers: new Map<string, string>(),
        },
        (interception) => {
          if (nextCalled) {
            throw new Error('signalReceived interceptor called next() more than once');
          }
          nextCalled = true;
          deliveryPromise = deliverSignal(
            interception.workflowId,
            interception.signalName,
            interception.payload,
          );
        },
      );
    } catch (error) {
      // Always await the delivery promise even if the interceptor threw after
      // calling next, to avoid orphaned unhandled promise rejections.
      if (deliveryPromise) await deliveryPromise;
      throw error;
    }
    // If interceptor blocked delivery by not calling next, return early
    if (!deliveryPromise) return;
    await deliveryPromise;
  } else {
    await deliverSignal(workflowId, name, payload);
  }
}

export function releaseSignalWaiter(
  internals: EngineInternals,
  workflowId: string,
  waiterKey: string,
  expectedResolve?: () => void,
): void {
  const currentWaiter = internals.signalWaiters.get(waiterKey);
  if (!currentWaiter) {
    return;
  }

  if (expectedResolve && currentWaiter !== expectedResolve) {
    return;
  }

  internals.signalWaiters.delete(waiterKey);
  untrackWaiterKey(internals.signalWaitersByWorkflow, workflowId, waiterKey);
}

export async function bufferSignalPayloads(
  internals: EngineInternals,
  workflowId: string,
  deliveries: BufferedSignalDelivery[],
  callbacks: SignalCallbacks,
  defaultOptions: SignalDeliveryOptions = {},
): Promise<void> {
  if (deliveries.length === 0) {
    return;
  }

  const targetState = await callbacks.loadWorkflowState(workflowId);
  if (targetState && isTerminalWorkflowStatus(targetState.status)) {
    return;
  }

  const signalId = getSingleSignalId(deliveries, defaultOptions);
  validateSignalIdsBeforeKeyConstruction(deliveries, defaultOptions, signalId);
  if (signalId !== undefined) {
    requireStorageCapability(internals.storage, 'conditionalBatch', 'signal idempotency');
  }

  if (signalId !== undefined) {
    const operations = createExplicitSignalOperations(internals, workflowId, deliveries, signalId);
    appendTerminalCleanupOperation(internals, workflowId, operations);
    const delivery = deliveries[0]!;
    const acceptedResponseKey = KEYS.signalAcceptedResponse(
      workflowId,
      delivery.signalName,
      signalId,
    );
    const acceptedResponse = encode(SIGNAL_ACCEPTED_RESPONSE);
    if ((await internals.storage.get(acceptedResponseKey)) !== null) {
      return;
    }
    // Gate on the `sigres:` accepted-response marker, not the `sig:` payload key:
    // it is the class-independent dedup identity (keyed by signalId alone), so a
    // concurrent start-batch signal of the same signalId — whose `sig:` key is
    // class `0`, not the class `1` this path writes — still collides here and is
    // deduped rather than buffered a second time (#458).
    const committed = await storageConditionalBatch(
      internals.storage,
      [{ key: acceptedResponseKey, expectedValue: null }],
      [...operations, { type: 'put', key: acceptedResponseKey, value: acceptedResponse }],
    );
    if (!committed) {
      // CAS loss means a concurrent caller already committed the `sigres:` marker
      // for this signalId (the early read above raced it). The signal is already
      // delivered exactly once; this duplicate is a no-op.
      return;
    }
    markTerminalCleanupTracked(internals, workflowId);
    deliverBufferedSignals(internals, workflowId, deliveries, callbacks);
    return;
  }

  await commitAnonymousSignalOperations(
    internals,
    workflowId,
    deliveries,
    (operations) => appendTerminalCleanupOperation(internals, workflowId, operations),
    () => markTerminalCleanupTracked(internals, workflowId),
  );
  deliverBufferedSignals(internals, workflowId, deliveries, callbacks);
}

function createExplicitSignalOperations(
  internals: EngineInternals,
  workflowId: string,
  deliveries: BufferedSignalDelivery[],
  signalId: string,
): BatchOperation[] {
  return deliveries.map(({ signalName, payload }) => ({
    type: 'put',
    key: KEYS.signal(workflowId, signalName, signalId),
    value: encodePayloadWithinLimit(
      payload,
      internals.options.payloadSizePolicy.maxBytes,
      'signal payload',
    ),
  }));
}

/**
 * Build the durable operations for a single keyed signal so it can be folded
 * into a workflow's create batch by {@link startOrSignal}. Writes the same pair
 * the live signal path writes — the `sig:` payload (consumed on first drive by
 * `processWaitSignalOperation`) and the `sigres:` accepted-response marker — so a
 * concurrent caller that falls back to the standard signal path dedups against
 * the SAME `signalId`. The accepted-response marker is consumption-independent:
 * even after the winning run consumes the `sig:` payload, a late loser finds the
 * `sigres:` key and short-circuits instead of re-delivering, which is what
 * guarantees "one signal per signalId" across the create and signal paths.
 *
 * Returns both the put operations and the CAS condition. The condition gates on
 * the `sigres:` accepted-response marker (the dedup identity, keyed by signalId
 * alone), NOT the `sig:` payload key: the FIFO sort-class (#458) makes the
 * start-signal's `sig:` key (class `0`) differ from the live signal path's (class
 * `1`), so a `sig:`-keyed CAS would no longer collide with a pre-buffered signal
 * of the same signalId and would buffer a second copy. The class-independent
 * `sigres:` marker is what both paths share, so gating on it preserves "one
 * signal per signalId" across the create and signal paths.
 */
export function buildCreateBatchSignalOperations(
  internals: EngineInternals,
  workflowId: string,
  signalName: string,
  payload: unknown,
  signalId: string,
): { operations: BatchOperation[]; condition: { key: string; expectedValue: null } } {
  validateSignalId(signalId);
  // `KEYS.startSignal` sorts the start-signal before any signal delivered later
  // in the same tick (before the workflow's first park); see `KEYS.startSignal`
  // and issue #458.
  const signalKey = KEYS.startSignal(workflowId, signalName, signalId);
  const acceptedResponseKey = KEYS.signalAcceptedResponse(workflowId, signalName, signalId);
  return {
    operations: [
      {
        type: 'put',
        key: signalKey,
        value: encodePayloadWithinLimit(
          payload,
          internals.options.payloadSizePolicy.maxBytes,
          'signal payload',
        ),
      },
      { type: 'put', key: acceptedResponseKey, value: encode(SIGNAL_ACCEPTED_RESPONSE) },
    ],
    condition: { key: acceptedResponseKey, expectedValue: null },
  };
}

function appendTerminalCleanupOperation(
  internals: EngineInternals,
  workflowId: string,
  operations: BatchOperation[],
): void {
  if (internals.workflowsNeedingTerminalCleanup.has(workflowId)) {
    return;
  }

  operations.push({
    type: 'put',
    key: KEYS.terminalCleanupNeeded(workflowId),
    value: EMPTY_STORAGE_VALUE,
  });
}

function markTerminalCleanupTracked(internals: EngineInternals, workflowId: string): void {
  internals.workflowsNeedingTerminalCleanup.add(workflowId);
}

function deliverBufferedSignals(
  internals: EngineInternals,
  workflowId: string,
  deliveries: BufferedSignalDelivery[],
  callbacks: SignalCallbacks,
): void {
  let shouldResumeParkedWorkflow = false;

  for (const { signalName, payload, options } of deliveries) {
    if (options?.emitPublicEvent !== false) {
      callbacks.dispatchEvent(new SignalReceivedEvent(workflowId, signalName, payload));
      callbacks.broadcast({ type: 'signal:received', workflowId, signalName });
    }

    const waiterKey = `${workflowId}:${signalName}`;
    const waiter = internals.signalWaiters.get(waiterKey);
    if (waiter) {
      releaseSignalWaiter(internals, workflowId, waiterKey, waiter);
      waiter();
      continue;
    }

    if (internals.parkedInlineWorkflows.has(workflowId)) {
      shouldResumeParkedWorkflow = true;
    }
  }

  if (shouldResumeParkedWorkflow) {
    void callbacks.resumeParkedInlineWorkflow(workflowId);
  }
}

export async function hasBufferedSignal(
  internals: EngineInternals,
  workflowId: string,
  signalName: string,
): Promise<boolean> {
  return (await findBufferedSignalRecord(internals, workflowId, signalName)) !== null;
}

export async function consumeSignal(
  internals: EngineInternals,
  workflowId: string,
  signalName: string,
): Promise<ConsumedSignalResult> {
  const record = await findBufferedSignalRecord(internals, workflowId, signalName);
  if (record === null) return { found: false };

  await internals.storage.delete(record.key);
  return { found: true, payload: decode(record.value) };
}

export async function consumeSignalWithAtomicWorkflowCommit(
  internals: EngineInternals,
  workflowId: string,
  signalName: string,
): Promise<ConsumedSignalResult> {
  const record = await findBufferedSignalRecord(internals, workflowId, signalName);
  if (record === null) return { found: false };

  stageAtomicWorkflowCommitSideEffects(internals, workflowId, {
    conditions: [{ key: record.key, expectedValue: new Uint8Array(record.value) }],
    operations: [{ type: 'delete', key: record.key }],
  });
  return { found: true, payload: decode(record.value) };
}

/**
 * Read the first buffered signal payload WITHOUT deleting it. Use when a caller
 * must check for a buffered signal but might not end up consuming it — e.g. a
 * `ctx.race` / `ctx.all` wait-signal branch that could lose, where a destructive
 * {@link consumeSignal} on the losing path would silently drop the signal. The
 * winner still calls {@link consumeSignal} exactly once to perform the durable
 * delete.
 */
export async function peekSignal(
  internals: EngineInternals,
  workflowId: string,
  signalName: string,
): Promise<ConsumedSignalResult> {
  const record = await findBufferedSignalRecord(internals, workflowId, signalName);
  return record === null ? { found: false } : { found: true, payload: decode(record.value) };
}

async function findBufferedSignalRecord(
  internals: EngineInternals,
  workflowId: string,
  signalName: string,
): Promise<BufferedSignalRecord | null> {
  const encodedWorkflowId = encodeStorageKeyComponent(workflowId);
  const encodedSignalName = encodeStorageKeyComponent(signalName);
  const encodedPrefix = signalKeyPrefix(encodedWorkflowId, encodedSignalName);
  const encodedRecord = await findBufferedSignalRecordByPrefix(
    internals,
    encodedPrefix,
    encodedWorkflowId,
    encodedSignalName,
  );
  return encodedRecord;
}

async function findBufferedSignalRecordByPrefix(
  internals: EngineInternals,
  prefix: string,
  encodedWorkflowId: string,
  signalNameKeyComponent: string,
): Promise<BufferedSignalRecord | null> {
  for await (const [key, value] of internals.storage.scan(prefix)) {
    if (isExactSignalKey(key, encodedWorkflowId, signalNameKeyComponent)) return { key, value };
  }

  return null;
}

function signalKeyPrefix(encodedWorkflowId: string, signalNameKeyComponent: string): string {
  return `sig:${encodedWorkflowId}:${signalNameKeyComponent}:`;
}

function isExactSignalKey(
  key: string,
  encodedWorkflowId: string,
  signalNameKeyComponent: string,
): boolean {
  const components = key.split(':');
  return (
    components.length === SIGNAL_KEY_COMPONENT_COUNT &&
    components[0] === 'sig' &&
    components[1] === encodedWorkflowId &&
    components[2] === signalNameKeyComponent &&
    (components[3] === '0' || components[3] === '1') &&
    components[4] !== ''
  );
}

function getSingleSignalId(
  deliveries: readonly BufferedSignalDelivery[],
  defaultOptions: SignalDeliveryOptions,
): string | undefined {
  if (deliveries.length !== 1) return undefined;
  return deliveries[0]?.options?.signalId ?? defaultOptions.signalId;
}

function validateSignalIdsBeforeKeyConstruction(
  deliveries: readonly BufferedSignalDelivery[],
  defaultOptions: SignalDeliveryOptions,
  singleSignalId: string | undefined,
): void {
  if (singleSignalId !== undefined) {
    validateSignalId(singleSignalId);
    return;
  }

  for (const delivery of deliveries) {
    const deliverySignalId = delivery.options?.signalId ?? defaultOptions.signalId;
    if (deliverySignalId !== undefined) {
      validateSignalId(deliverySignalId);
    }
  }
}

/** Register a waiter key in a workflow-keyed reverse index. */
export function trackWaiterKey(
  reverseIndex: Map<string, TrackedWaiterKeys>,
  workflowId: string,
  waiterKey: string,
): void {
  let keys = reverseIndex.get(workflowId);
  if (!keys) {
    reverseIndex.set(workflowId, waiterKey);
    return;
  }

  if (typeof keys === 'string') {
    if (keys === waiterKey) {
      return;
    }

    reverseIndex.set(workflowId, new Set([keys, waiterKey]));
    return;
  }

  keys.add(waiterKey);
}

/** Remove a waiter key from a workflow-keyed reverse index. */
export function untrackWaiterKey(
  reverseIndex: Map<string, TrackedWaiterKeys>,
  workflowId: string,
  waiterKey: string,
): void {
  const keys = reverseIndex.get(workflowId);
  if (!keys) {
    return;
  }

  if (typeof keys === 'string') {
    if (keys === waiterKey) {
      reverseIndex.delete(workflowId);
    }
    return;
  }

  keys.delete(waiterKey);
  if (keys.size === 0) {
    reverseIndex.delete(workflowId);
    return;
  }

  if (keys.size === 1) {
    const [remainingWaiterKey] = keys;
    if (remainingWaiterKey !== undefined) {
      reverseIndex.set(workflowId, remainingWaiterKey);
    }
  }
}

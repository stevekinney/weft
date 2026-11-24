import {
  storageValuesEqual,
  type BatchOperation,
  type ConditionalBatchCondition,
  type Storage,
} from "../../embedded/storage/src/index.ts";

import type { ContextOperationRequest } from '../context.ts';
import type { EngineInternals } from './internals.ts';
import { capturedSideEffectSinkOf } from './side-effect-capture.ts';

export type AtomicWorkflowCommitSideEffects = {
  conditions: ConditionalBatchCondition[];
  operations: BatchOperation[];
};

type SharedReceiptTransition = {
  readonly operation: Extract<BatchOperation, { type: 'put' }>;
  readonly condition: ConditionalBatchCondition;
};

const sharedReceiptTransitions = new WeakMap<BatchOperation, SharedReceiptTransition>();

/** Give every consumer of one keyed result the same receipt transition. */
export function shareActivityReceiptTransition(sideEffects: {
  operations: [SharedReceiptTransition['operation']];
  conditions: [ConditionalBatchCondition];
}): void {
  const [operation] = sideEffects.operations;
  const [condition] = sideEffects.conditions;
  sharedReceiptTransitions.set(operation, { operation, condition });
}

/**
 * Coalesce repeated copies within one batch and reuse a sibling's durable receipt.
 * A storage acknowledgement can be lost even after the checkpoint landed. Only
 * the exact completed bytes permit dropping a repeated put, and the final batch
 * still compares those bytes along with its checkpoint and lease preconditions.
 */
export function prepareSharedActivityReceiptTransitions(
  storage: Pick<Storage, 'get'>,
  operations: BatchOperation[],
  conditions: ConditionalBatchCondition[],
): Promise<AtomicWorkflowCommitSideEffects> | undefined {
  const transitions = new Map<ConditionalBatchCondition, SharedReceiptTransition>();
  for (const operation of operations) {
    const shared = sharedReceiptTransitions.get(operation);
    if (shared === undefined) continue;
    if (!conditions.includes(shared.condition)) {
      throw new Error('Shared activity receipt transition has no matching checkpoint condition');
    }
    transitions.set(shared.condition, shared);
  }
  if (transitions.size === 0) return undefined;
  return consolidateReceiptTransitions(storage, operations, conditions, transitions);
}

async function consolidateReceiptTransitions(
  storage: Pick<Storage, 'get'>,
  operations: BatchOperation[],
  conditions: ConditionalBatchCondition[],
  transitions: ReadonlyMap<ConditionalBatchCondition, SharedReceiptTransition>,
): Promise<AtomicWorkflowCommitSideEffects> {
  const committed = new Set<SharedReceiptTransition>();
  await Promise.all(
    [...transitions.values()].map(async (transition) => {
      const stored = await storage.get(transition.operation.key);
      if (storageValuesEqual(stored, transition.operation.value)) committed.add(transition);
    }),
  );

  const repeatedWrites = new Set<SharedReceiptTransition>();
  const writes = operations.filter((operation) => {
    const shared = sharedReceiptTransitions.get(operation);
    if (shared === undefined) return true;
    if (committed.has(shared) || repeatedWrites.has(shared)) return false;
    repeatedWrites.add(shared);
    return true;
  });
  const repeatedChecks = new Set<SharedReceiptTransition>();
  const checks = conditions.flatMap((condition) => {
    const shared = transitions.get(condition);
    if (shared === undefined) return [condition];
    if (repeatedChecks.has(shared)) return [];
    repeatedChecks.add(shared);
    return [
      committed.has(shared) ? { ...condition, expectedValue: shared.operation.value } : condition,
    ];
  });
  return { operations: writes, conditions: checks };
}

export function stageAtomicWorkflowCommitSideEffects(
  internals: EngineInternals,
  workflowId: string,
  sideEffects: AtomicWorkflowCommitSideEffects,
  workflowExecutionToken?: string,
  bindToExecutionGeneration = false,
): void {
  if (sideEffects.conditions.length === 0 && sideEffects.operations.length === 0) {
    return;
  }
  if (bindToExecutionGeneration) {
    stageBoundSideEffects(internals, workflowId, sideEffects, workflowExecutionToken);
    return;
  }
  const pending = internals.pendingAtomicWorkflowCommitSideEffects.get(workflowId);
  if (pending === undefined) {
    internals.pendingAtomicWorkflowCommitSideEffects.set(workflowId, {
      conditions: [...sideEffects.conditions],
      operations: [...sideEffects.operations],
    });
    return;
  }

  pending.conditions.push(...sideEffects.conditions);
  pending.operations.push(...sideEffects.operations);
}

/**
 * Stage side effects `operation` asked for, for the next checkpoint: into the capture a
 * coordinator attached to the operation, which commits them with the operation's result (see
 * `side-effect-capture.ts`), or else into the workflow's staged buffer.
 */
export function stageOperationSideEffects(
  internals: EngineInternals,
  workflowId: string,
  operation: ContextOperationRequest | undefined,
  sideEffects: AtomicWorkflowCommitSideEffects,
  workflowExecutionToken?: string,
  bindToExecutionGeneration = false,
): void {
  const sink = operation === undefined ? undefined : capturedSideEffectSinkOf(operation);
  if (sink === undefined) {
    stageAtomicWorkflowCommitSideEffects(
      internals,
      workflowId,
      sideEffects,
      workflowExecutionToken,
      bindToExecutionGeneration,
    );
  } else if (sideEffects.conditions.length > 0 || sideEffects.operations.length > 0) {
    sink(sideEffects, workflowExecutionToken, bindToExecutionGeneration);
  }
}

/** Stage side effects bound to the run generation `workflowExecutionToken` names. */
function stageBoundSideEffects(
  internals: EngineInternals,
  workflowId: string,
  sideEffects: AtomicWorkflowCommitSideEffects,
  workflowExecutionToken: string | undefined,
): void {
  internals.pendingOperationAtomicWorkflowCommitSideEffects ??= new Map();
  const byToken =
    internals.pendingOperationAtomicWorkflowCommitSideEffects.get(workflowId) ?? new Map();
  const tokenKey = workflowExecutionToken ?? '';
  const pending = byToken.get(tokenKey);
  if (pending === undefined) {
    byToken.set(tokenKey, {
      conditions: [...sideEffects.conditions],
      operations: [...sideEffects.operations],
    });
  } else {
    pending.conditions.push(...sideEffects.conditions);
    pending.operations.push(...sideEffects.operations);
  }
  internals.pendingOperationAtomicWorkflowCommitSideEffects.set(workflowId, byToken);
}

export function takePendingAtomicWorkflowCommitSideEffects(
  internals: EngineInternals,
  workflowId: string,
  workflowExecutionToken?: string,
): AtomicWorkflowCommitSideEffects | undefined {
  const pendingEntries = [] as AtomicWorkflowCommitSideEffects[];
  const unbound = internals.pendingAtomicWorkflowCommitSideEffects.get(workflowId);
  if (unbound !== undefined) {
    internals.pendingAtomicWorkflowCommitSideEffects.delete(workflowId);
    pendingEntries.push(unbound);
  }
  const byToken = internals.pendingOperationAtomicWorkflowCommitSideEffects?.get(workflowId);
  if (byToken !== undefined) {
    internals.pendingOperationAtomicWorkflowCommitSideEffects.delete(workflowId);
    const bound = byToken.get(workflowExecutionToken ?? '');
    if (bound !== undefined) pendingEntries.push(bound);
  }
  if (pendingEntries.length === 0) return undefined;
  const pending = pendingEntries.reduce(
    (combined, entry) => ({
      conditions: [...combined.conditions, ...entry.conditions],
      operations: [...combined.operations, ...entry.operations],
    }),
    { conditions: [], operations: [] } as AtomicWorkflowCommitSideEffects,
  );
  if (pending.conditions.length === 0 && pending.operations.length === 0) {
    return undefined;
  }

  return {
    conditions: [...pending.conditions],
    operations: [...pending.operations],
  };
}

/**
 * The side effects a checkpoint commit writes: the `held` ones a coordinator passes for a commit
 * made while its operation still runs (see `held-side-effects.ts`), which leaves the staged buffer
 * to the commit that settles the operation, or else the staged buffer itself. `fromStaged` says
 * whether the buffer was taken, so the commit clears it once it lands.
 */
export function takeCommitSideEffects(
  internals: EngineInternals,
  workflowId: string,
  workflowExecutionToken: string | undefined,
  held: AtomicWorkflowCommitSideEffects | undefined,
): { sideEffects: AtomicWorkflowCommitSideEffects | undefined; fromStaged: boolean } {
  if (held !== undefined) return { sideEffects: held, fromStaged: false };
  const staged = takePendingAtomicWorkflowCommitSideEffects(
    internals,
    workflowId,
    workflowExecutionToken,
  );
  return { sideEffects: staged, fromStaged: staged !== undefined };
}

export function clearPendingAtomicWorkflowCommitSideEffects(
  internals: EngineInternals,
  workflowId: string,
): void {
  internals.pendingAtomicWorkflowCommitSideEffects.delete(workflowId);
  internals.pendingOperationAtomicWorkflowCommitSideEffects?.delete(workflowId);
}

export function clearAllPendingAtomicWorkflowCommitSideEffects(internals: EngineInternals): void {
  internals.pendingAtomicWorkflowCommitSideEffects.clear();
  internals.pendingOperationAtomicWorkflowCommitSideEffects?.clear();
}

/**
 * Non-destructively report whether a workflow's pending atomic side-effect buffer
 * already stages a `put` to `key`. Unlike {@link takePendingAtomicWorkflowCommitSideEffects},
 * this does NOT consume the buffer, so it is safe to call at a gate that runs before the
 * commit that will flush those same side-effects.
 *
 * The terminal-transition path (#446) needs this: `ctx.setFinalizerState()` stages the
 * `wf-finalizer-state:` put as a pending side-effect that the terminal batch flushes, but
 * a pre-batch `storage.get()` cannot see a staged-but-unflushed write. Peeking the buffer
 * lets the terminal batch stage its teardown marker atomically alongside that put — without
 * it, a `setFinalizerState` with no intervening checkpoint would commit the resource state
 * yet skip the teardown marker, silently leaking the external resource.
 */
export function pendingAtomicWorkflowCommitSideEffectsStagePut(
  internals: EngineInternals,
  workflowId: string,
  key: string,
): boolean {
  const pending = internals.pendingAtomicWorkflowCommitSideEffects.get(workflowId);
  if (pending === undefined) {
    return false;
  }
  return pending.operations.some((operation) => operation.type === 'put' && operation.key === key);
}

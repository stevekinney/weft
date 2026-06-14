import type { HumanReviewOptions, HumanReviewResult } from '../review/index.ts';
import { parseDuration } from '../scheduler.ts';
import type { Duration } from '../types.ts';
import type { Context } from './index.ts';
import type { ContextInternals } from './internals.ts';
import type { ContextOperationRequest } from './operation-request.ts';
import type { OffloadReference, StreamReference, StreamSink } from './types.ts';
import { captureCallerStack } from './validation.ts';
import { resolveWorkflowVersionPatch } from './version-patching.ts';

export type PreparedSleepOperation =
  | { cached: true }
  | { cached: false; milliseconds: number; request: ContextOperationRequest; step: number };

export function prepareSleepOperation(
  internals: ContextInternals,
  duration: Duration,
): PreparedSleepOperation {
  const step = internals.stepIndex++;

  if (internals.accumulatedResults?.has(step)) return { cached: true };

  const milliseconds = parseDuration(duration);

  if (internals.explainMode) {
    console.log(`[weft] ctx.sleep(${JSON.stringify(duration)})`);
    console.log(`  → Creating checkpoint at step ${step}`);
    console.log(`  → Scheduling timer for ${milliseconds}ms`);
  }

  const operationId = crypto.randomUUID();
  const callerStack = captureCallerStack();
  const referenceTime = internals.sleepReferenceTime ?? internals.getNow();
  internals.sleepReferenceTime = undefined;

  return {
    cached: false,
    milliseconds,
    request: {
      type: 'sleep',
      operationId,
      duration: milliseconds,
      scheduledFireAt: referenceTime + milliseconds,
      callerStack,
    },
    step,
  };
}

export function* completePreparedSleepOperation(
  context: Context,
  prepared: Exclude<PreparedSleepOperation, { cached: true }>,
): Generator<ContextOperationRequest, void, unknown> {
  yield prepared.request;
  context.accumulatedResults.set(prepared.step, undefined);
}

export function* sleep(
  context: Context,
  internals: ContextInternals,
  duration: Duration,
): Generator<ContextOperationRequest, void, unknown> {
  const prepared = prepareSleepOperation(internals, duration);
  if (prepared.cached) return;
  yield* completePreparedSleepOperation(context, prepared);
}

export function* waitForSignal<T = unknown>(
  context: Context,
  internals: ContextInternals,
  name: string,
): Generator<ContextOperationRequest, T, unknown> {
  const step = internals.stepIndex++;

  if (internals.accumulatedResults?.has(step)) {
    return internals.accumulatedResults.get(step) as T;
  }

  if (internals.explainMode) {
    console.log(`[weft] ctx.waitForSignal("${name}")`);
    console.log(`  → Creating checkpoint at step ${step}`);
    console.log(`  → Waiting for signal "${name}"`);
  }

  const operationId = crypto.randomUUID();
  const callerStack = captureCallerStack();
  const result = yield {
    type: 'wait-signal',
    operationId,
    signalName: name,
    callerStack,
  };

  context.accumulatedResults.set(step, result);
  return result as T;
}

const CONDITION_DEADLINE_LOCAL_PREFIX = '__weftConditionDeadline:';

/**
 * Read the absolute deadline anchor for a `ctx.waitUntil` step, writing it on the
 * first evaluation. Read-first so a crash/replay never resets the window: the
 * timeout is measured from the original first yield, and the anchor lands in the
 * checkpoint committed at that yield — the same atomicity the activity
 * schedule-to-close anchor (`readOrInitActivityDispatchedAt`) relies on.
 *
 * Returns `undefined` when no timeout was supplied (wait forever).
 */
export function readOrInitConditionDeadline(
  internals: ContextInternals,
  step: number,
  timeout: Duration | undefined,
): number | undefined {
  if (timeout === undefined) return undefined;

  const localKey = `${CONDITION_DEADLINE_LOCAL_PREFIX}${step}`;
  const existing = internals.checkpointLocals[localKey];
  // Honor any finite anchor, including 0 (a test clock can legitimately report a
  // 0 reference time); an `existing > 0` guard would treat that as unset and
  // re-anchor on every replay, resetting the wall-clock budget.
  if (typeof existing === 'number' && Number.isFinite(existing)) {
    return existing;
  }
  // A present-but-non-finite anchor is corrupt persisted data. Fail loudly rather
  // than silently re-initializing, which would reset the timeout window the
  // anchor exists to uphold. Only an ABSENT anchor is a legitimate first eval.
  if (existing !== undefined) {
    throw new Error(
      `Invalid checkpointed wait-condition deadline ${JSON.stringify(existing)} for step ${step}`,
    );
  }

  const milliseconds = parseDuration(timeout);
  const referenceTime = internals.sleepReferenceTime ?? internals.getNow();
  internals.sleepReferenceTime = undefined;
  const deadline = referenceTime + milliseconds;
  // Reassign rather than mutate in place: `checkpointLocals` is frozen between
  // operations (the activity-retry-state precedent), so an in-place write throws.
  internals.checkpointLocals = { ...internals.checkpointLocals, [localKey]: deadline };
  return deadline;
}

/**
 * Wait until `predicate` returns `true`, re-evaluated by the engine each time the
 * workflow is driven forward (an `onUpdate` handler mutating state, or the
 * optional timeout). The predicate is a non-serializable closure held in-process,
 * never checkpointed. Once the wait outcome has been checkpointed, replay returns
 * the cached outcome and does not re-invoke the predicate. A predicate that
 * throws fails the workflow at the `yield*` call site (like a throwing activity).
 * Inline execution only.
 *
 * With no `timeout` the generator yields `void` (waits forever). With a `timeout`
 * it yields `true` when the predicate was met or `false` when the deadline
 * elapsed first.
 */
export function* waitUntil(
  context: Context,
  internals: ContextInternals,
  predicate: () => boolean,
  timeout?: Duration,
): Generator<ContextOperationRequest, boolean | void, unknown> {
  const step = internals.stepIndex++;

  if (internals.accumulatedResults?.has(step)) {
    return internals.accumulatedResults.get(step) as boolean | void;
  }

  // Always yield the request on a fresh run — never short-circuit, even when the
  // predicate is already true. The engine processor's first `predicate()` check
  // completes an immediately-true wait on the spot (one checkpoint, the cost
  // every durable op already pays). Yielding unconditionally is what lets the
  // race/all guard (sub-operation.ts) reject a `waitUntil` branch consistently:
  // a fast-path return would skip the yield, so `race([waitUntil(() => true)])`
  // would silently complete the branch instead of throwing.
  const deadline = readOrInitConditionDeadline(internals, step, timeout);

  if (internals.explainMode) {
    console.log('[weft] ctx.waitUntil(predicate)');
    console.log(`  → Creating checkpoint at step ${step}`);
    console.log(
      deadline === undefined ? '  → Waiting indefinitely' : `  → Deadline at ${deadline}`,
    );
  }

  const operationId = crypto.randomUUID();
  const callerStack = captureCallerStack();
  const result = yield {
    type: 'wait-condition',
    operationId,
    step,
    predicate,
    ...(deadline !== undefined && { deadline }),
    callerStack,
  };

  context.accumulatedResults.set(step, result);
  return result as boolean | void;
}

export function* getVersion(
  _context: Context,
  internals: ContextInternals,
  changeId: string,
  minSupported: number,
  maxSupported: number,
): Generator<ContextOperationRequest, number, unknown> {
  const step = internals.stepIndex++;
  const resolution = resolveWorkflowVersionPatch(
    internals.checkpointLocals,
    changeId,
    minSupported,
    maxSupported,
  );
  internals.checkpointLocals = resolution.checkpointLocals;

  if (!resolution.newlyPinned) {
    return resolution.version;
  }

  if (internals.accumulatedResults?.has(step)) {
    const cachedVersion = internals.accumulatedResults.get(step);
    if (cachedVersion !== resolution.version) {
      throw new Error(
        `ctx.getVersion("${changeId}") replay result ${String(cachedVersion)} does not match pinned version ${String(resolution.version)}`,
      );
    }
    return resolution.version;
  }

  if (internals.explainMode) {
    console.log(`[weft] ctx.getVersion("${changeId}", ${minSupported}, ${maxSupported})`);
    console.log(`  → Creating checkpoint at step ${step}`);
    console.log(`  → Pinning workflow patch "${changeId}" to version ${resolution.version}`);
  }

  const operationId = crypto.randomUUID();
  const callerStack = captureCallerStack();
  const result = yield {
    type: 'get-version' as const,
    operationId,
    changeId,
    minSupported,
    maxSupported,
    version: resolution.version,
    callerStack,
  };

  return result as number;
}

export function* waitForUpdate<T = unknown>(
  context: Context,
  internals: ContextInternals,
  name: string,
): Generator<ContextOperationRequest, { payload: T; respond: (result: unknown) => void }, unknown> {
  const step = internals.stepIndex++;

  if (internals.accumulatedResults?.has(step)) {
    const cached = internals.accumulatedResults.get(step) as { payload: T };
    return { payload: cached.payload, respond: () => {} };
  }

  if (internals.explainMode) {
    console.log(`[weft] ctx.waitForUpdate("${name}")`);
    console.log(`  → Creating checkpoint at step ${step}`);
    console.log(`  → Waiting for update "${name}"`);
  }

  const operationId = crypto.randomUUID();
  const callerStack = captureCallerStack();
  const result = yield {
    type: 'wait-update',
    operationId,
    updateName: name,
    callerStack,
  };

  const envelope = result as { payload: T; respond: (result: unknown) => void };
  context.accumulatedResults.set(step, { payload: envelope.payload });
  return envelope;
}

export function* review(
  context: Context,
  internals: ContextInternals,
  options: HumanReviewOptions,
): Generator<ContextOperationRequest, HumanReviewResult, unknown> {
  const step = internals.stepIndex++;

  if (internals.accumulatedResults?.has(step)) {
    return internals.accumulatedResults.get(step) as HumanReviewResult;
  }

  if (internals.explainMode) {
    console.log(`[weft] ctx.review(${JSON.stringify(options.reviewType ?? 'general')})`);
    console.log(`  → Creating checkpoint at step ${step}`);
    console.log(`  → Pausing for human review`);
  }

  const operationId = crypto.randomUUID();
  const callerStack = captureCallerStack();
  const result = yield {
    type: 'wait-review' as const,
    operationId,
    reviewOptions: options,
    callerStack,
  };

  context.accumulatedResults.set(step, result);
  return result as HumanReviewResult;
}

export function* offload<T>(
  context: Context,
  internals: ContextInternals,
  key: string,
  fn: () => Promise<T>,
): Generator<ContextOperationRequest, OffloadReference, unknown> {
  const step = internals.stepIndex++;

  if (internals.accumulatedResults?.has(step)) {
    return internals.accumulatedResults.get(step) as OffloadReference;
  }

  if (internals.explainMode) {
    console.log(`[weft] ctx.offload("${key}")`);
    console.log(`  → Creating checkpoint at step ${step}`);
    console.log(`  → Offloading data for key "${key}" to external storage`);
  }

  const operationId = crypto.randomUUID();
  const callerStack = captureCallerStack();
  const result = yield {
    type: 'offload' as const,
    operationId,
    key,
    fn,
    callerStack,
  };

  context.accumulatedResults.set(step, result);
  return result as OffloadReference;
}

export function* stream(
  context: Context,
  internals: ContextInternals,
  key: string,
  fn: (sink: StreamSink) => AsyncGenerator<unknown, void, unknown>,
): Generator<ContextOperationRequest, StreamReference, unknown> {
  const step = internals.stepIndex++;

  if (internals.accumulatedResults?.has(step)) {
    return internals.accumulatedResults.get(step) as StreamReference;
  }

  if (internals.explainMode) {
    console.log(`[weft] ctx.stream("${key}")`);
    console.log(`  → Creating checkpoint at step ${step}`);
    console.log(`  → Streaming data for key "${key}" to external storage`);
  }

  const operationId = crypto.randomUUID();
  const callerStack = captureCallerStack();
  const result = yield {
    type: 'stream' as const,
    operationId,
    key,
    fn,
    callerStack,
  };

  context.accumulatedResults.set(step, result);
  return result as StreamReference;
}

export function* load<T>(
  context: Context,
  internals: ContextInternals,
  reference: OffloadReference,
): Generator<ContextOperationRequest, T, unknown> {
  const step = internals.stepIndex++;

  if (internals.accumulatedResults?.has(step)) {
    return internals.accumulatedResults.get(step) as T;
  }

  if (internals.explainMode) {
    console.log(`[weft] ctx.load("${reference.key}")`);
    console.log(`  → Creating checkpoint at step ${step}`);
    console.log(`  → Loading offloaded data for key "${reference.key}"`);
  }

  const operationId = crypto.randomUUID();
  const callerStack = captureCallerStack();
  const result = yield {
    type: 'load' as const,
    operationId,
    reference,
    callerStack,
  };

  context.accumulatedResults.set(step, result);
  return result as T;
}

export function* archive(
  context: Context,
  internals: ContextInternals,
  key: string,
  data: unknown,
): Generator<ContextOperationRequest, void, unknown> {
  const step = internals.stepIndex++;

  if (internals.accumulatedResults?.has(step)) return;

  if (internals.explainMode) {
    console.log(`[weft] ctx.archive("${key}")`);
    console.log(`  → Creating checkpoint at step ${step}`);
    console.log(`  → Archiving data for key "${key}"`);
  }

  const operationId = crypto.randomUUID();
  const callerStack = captureCallerStack();
  yield {
    type: 'archive' as const,
    operationId,
    key,
    data,
    callerStack,
  };

  context.accumulatedResults.set(step, undefined);
}

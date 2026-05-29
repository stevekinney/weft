import type { HumanReviewOptions, HumanReviewResult } from '../review/index.ts';
import { parseDuration } from '../scheduler.ts';
import type { Duration } from '../types.ts';
import type { Context } from './index.ts';
import type { ContextInternals } from './internals.ts';
import type { ContextOperationRequest } from './operation-request.ts';
import type { OffloadReference, StreamReference, StreamSink } from './types.ts';
import { captureCallerStack } from './validation.ts';

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

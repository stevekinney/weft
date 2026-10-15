import { describe, expect, it } from 'bun:test';

import { Context } from '../context.ts';
import { prepareSleepOperation } from './durable-operations.ts';
import { getInternals } from './internals.ts';
import type { ContextOperationRequest } from './operation-request.ts';

const CHECKPOINT_CREATED_AT = 1_000;
const ONE_HOUR = 3_600_000;
const SETTLED_AT = 90_000;

// Atomic state handles type their yields as `unknown`, so the table accepts any yield type.
type Operation = Generator<unknown, unknown, unknown>;

function createResumedContext(getNow: () => number) {
  return new Context({
    workflowId: 'wf-sleep-reference-time',
    workflowType: 'sleep-reference-time-test',
    startedAt: 0,
    abortController: new AbortController(),
    getNow,
    sleepReferenceTime: CHECKPOINT_CREATED_AT,
  });
}

function prepareFireAt(context: Context, duration: string): number {
  const prepared = prepareSleepOperation(getInternals(context), duration);
  if (prepared.cached) throw new Error('expected an uncached sleep');
  if (prepared.request.type !== 'sleep') throw new Error('expected a sleep request');
  return prepared.request.scheduledFireAt;
}

function sleepFireAt(request: ContextOperationRequest): number {
  if (request.type !== 'sleep') throw new Error(`expected a sleep request, got ${request.type}`);
  return request.scheduledFireAt;
}

function nextRequest<TRequest>(operation: Generator<TRequest, unknown, unknown>): TRequest {
  const yielded = operation.next();
  if (yielded.done) throw new Error('expected the operation to yield a request');
  return yielded.value;
}

// Every uncached operation that parks on the engine. Each entry starts the
// operation on a resumed context and names the result the engine hands back.
const uncachedOperations: Array<{
  name: string;
  start: (context: Context) => Operation;
  result: unknown;
}> = [
  { name: 'ctx.waitForSignal', start: (context) => context.waitForSignal('go'), result: 'payload' },
  {
    name: 'ctx.waitForUpdate',
    start: (context) => context.waitForUpdate('approve'),
    result: { payload: 'approved', respond: () => {} },
  },
  {
    name: 'ctx.waitUntil without a timeout',
    start: (context) => context.waitUntil(() => false),
    result: undefined,
  },
  { name: 'ctx.getVersion', start: (context) => context.getVersion('change', 1, 2), result: 2 },
  {
    name: 'ctx.review',
    start: (context) => context.review({ artifact: 'draft' }),
    result: { decision: 'approved' },
  },
  {
    name: 'ctx.offload',
    start: (context) => context.offload('blob', async () => 'data'),
    result: { key: 'blob', workflowId: 'wf-sleep-reference-time', sizeBytes: 4 },
  },
  {
    name: 'ctx.stream',
    start: (context) => context.stream('chunks', async function* () {}),
    result: { key: 'chunks' },
  },
  {
    name: 'ctx.load',
    start: (context) =>
      context.load({ key: 'blob', workflowId: 'wf-sleep-reference-time', sizeBytes: 4 }),
    result: 'data',
  },
  {
    name: 'ctx.archive',
    start: (context) => context.archive('record', { id: 1 }),
    result: undefined,
  },
  { name: 'ctx.memo', start: (context) => context.memo('value', () => 1), result: 1 },
  {
    name: 'ctx.run',
    start: (context) => context.run(async (value: number) => value, 1),
    result: 1,
  },
  { name: 'ctx.startChild', start: (context) => context.startChild('child', {}), result: 'done' },
  {
    name: 'ctx.speculate',
    start: (context) =>
      context.speculate(function* () {
        return 1;
      }),
    result: 1,
  },
  {
    name: 'ctx.all',
    start: (context) => context.all([context.waitForSignal('go')]),
    result: ['payload'],
  },
  {
    name: 'ctx.race',
    start: (context) => context.race([context.waitForSignal('go')]),
    result: 'payload',
  },
  {
    name: 'ctx.state.execution().get',
    start: (context) => context.state.execution<number>('counter').get(),
    result: { value: 1, version: 1 },
  },
];

describe('sleep reference time after resume', () => {
  it('anchors the first uncached sleep to the resumed checkpoint time', () => {
    const context = createResumedContext(() => 50_000);
    expect(prepareFireAt(context, '1h')).toBe(CHECKPOINT_CREATED_AT + ONE_HOUR);
  });

  for (const operation of uncachedOperations) {
    it(`anchors a sleep after a resumed ${operation.name} to the clock, not the checkpoint`, () => {
      let now = 2_000;
      const context = createResumedContext(() => now);

      const running = operation.start(context);
      nextRequest(running);
      now = SETTLED_AT;
      expect(running.next(operation.result).done).toBe(true);

      expect(prepareFireAt(context, '1h')).toBe(SETTLED_AT + ONE_HOUR);
    });
  }

  it('anchors a sleep to the clock after the engine throws into a resumed operation', () => {
    let now = 2_000;
    const context = createResumedContext(() => now);

    const running = context.waitForSignal('go');
    nextRequest(running);
    now = SETTLED_AT;
    expect(() => running.throw(new Error('cancelled'))).toThrow('cancelled');

    expect(prepareFireAt(context, '1h')).toBe(SETTLED_AT + ONE_HOUR);
  });

  it('keeps the checkpoint anchor for a sleep branch primed beside a signal wait', () => {
    let now = 50_000;
    const context = createResumedContext(() => now);

    const parallel = context.all([context.waitForSignal('go'), context.sleep('1h')]);
    const request = nextRequest(parallel);
    if (request.type !== 'parallel') throw new Error(`expected parallel, got ${request.type}`);
    expect(sleepFireAt(request.operations[1]!)).toBe(CHECKPOINT_CREATED_AT + ONE_HOUR);

    now = SETTLED_AT;
    expect(parallel.next(['payload', undefined]).done).toBe(true);
    expect(prepareFireAt(context, '1h')).toBe(SETTLED_AT + ONE_HOUR);
  });
});

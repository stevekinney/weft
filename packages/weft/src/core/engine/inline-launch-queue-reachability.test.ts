/**
 * COR-1425: an engine whose scheduled flush has not run must stay reachable.
 *
 * A queued inline start runs only when the engine's flush message is delivered, and the handler
 * for that message reaches its engine through a `WeakRef`. A caller that keeps only the promise
 * from `handle.result()`, or a continuation suspended on it, holds nothing a garbage collector
 * treats as a root: that continuation, the handle, the result waiter, the engine, and the engine's
 * internals reference only one another. So a collection between the end of the microtask turn
 * that queued the start and the delivery of the flush reclaimed the engine, the handler found
 * nothing to run, and `result()` never settled. Weft's bulk-signal test hung this way whenever
 * JavaScriptCore collected at that boundary, which Bun's event loop does when a collection timer
 * is pending as it takes newly posted tasks.
 *
 * The first test forces that ordering instead of waiting for load to produce it: it holds each
 * engine's flush message as it is delivered, runs a full collection, and only then lets the flush
 * run. The second proves the engine is held only for that window.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { Engine } from '../engine.ts';
import { workflow, type WorkflowContext } from '../types.ts';
import { isEngineHeldForScheduledInlineFlushForTesting } from './inline-launch-queue.ts';
import { getInternals } from './internals.ts';

const ECHO_WORKFLOW = 'inline-launch-queue-reachability-echo';

const echo = workflow({ name: ECHO_WORKFLOW }).execute(async function* (
  _ctx: WorkflowContext,
  input: string,
) {
  return input;
});

/**
 * Enough engines that all of them surviving a collection cannot happen by accident. A collection
 * can keep an otherwise unreachable object alive through the runtime's own roots, such as a
 * conservatively scanned stack slot or a scope held by a concurrent JIT compilation. Without the
 * fix, those kept at most four engines of ten alive across a hundred measured runs.
 */
const ENGINE_COUNT = 10;

type FlushHolder = {
  /** Settles once every expected flush message has arrived and is being held. */
  allArrived: Promise<void>;
  /** Wrap `port`'s handler so the flush message it receives is held instead of run. */
  hold: (port: MessagePort) => void;
  /** Run every held flush message through the engine's own handler. */
  release: () => void;
};

/**
 * Defined at module scope so that none of its closures can capture an engine: each keeps only the
 * engine's original handler, which reaches the engine weakly, and the delivered message event.
 */
function createFlushHolder(expectedMessages: number): FlushHolder {
  const held: Array<() => void> = [];
  const allArrived = Promise.withResolvers<void>();
  return {
    allArrived: allArrived.promise,
    hold(port) {
      const deliver = port.onmessage as (this: MessagePort, event: MessageEvent) => void;
      port.onmessage = function (this: MessagePort, event: MessageEvent) {
        held.push(() => {
          deliver.call(this, event);
        });
        if (held.length === expectedMessages) allArrived.resolve();
      };
    },
    release() {
      for (const run of held.splice(0)) run();
    },
  };
}

function flushPort(engine: Engine): MessagePort {
  const channel = getInternals(engine).queuedInlineWorkflowStartChannel;
  if (channel === null) throw new Error('Expected an event-loop inline launch channel.');
  return channel.port1;
}

/**
 * Start one echo workflow on each of `engineCount` fresh engines, holding every flush, and return
 * only weak references to the engines and the result promises, neither of which keeps an engine
 * alive.
 */
async function startOneWorkflowPerEngine(
  engineCount: number,
  holder: FlushHolder,
): Promise<{ engines: Array<WeakRef<Engine>>; results: Array<Promise<unknown>> }> {
  const engines: Array<WeakRef<Engine>> = [];
  const results: Array<Promise<unknown>> = [];
  for (let index = 0; index < engineCount; index++) {
    const engine = new Engine({ storage: new MemoryStorage() });
    engine.register(echo);
    holder.hold(flushPort(engine));
    const handle = await engine.start(ECHO_WORKFLOW, `result-${String(index)}`);
    engines.push(new WeakRef(engine));
    results.push(handle.result());
  }
  return { engines, results };
}

describe('inline launch queue reachability (COR-1425)', () => {
  it('keeps every engine with a pending scheduled flush alive through a garbage collection', async () => {
    const holder = createFlushHolder(ENGINE_COUNT);
    const { engines, results } = await startOneWorkflowPerEngine(ENGINE_COUNT, holder);
    await holder.allArrived;

    const survivors: Array<Engine | undefined> = [];
    try {
      // The test now holds only weak references and result promises, so each engine's pending
      // flush is the only thing that can keep it reachable through this collection.
      Bun.gc(true);
      survivors.push(...engines.map((engine) => engine.deref()));
      holder.release();

      expect(survivors.filter((engine) => engine === undefined)).toHaveLength(0);
      expect(await Promise.all(results)).toEqual(
        Array.from({ length: ENGINE_COUNT }, (_, index) => `result-${String(index)}`),
      );
    } finally {
      for (const engine of survivors) await engine?.[Symbol.asyncDispose]();
    }
  });

  it('holds an engine only until its scheduled flush starts or its queue is drained or discarded', async () => {
    await using flushed = new Engine({ storage: new MemoryStorage() });
    flushed.register(echo);
    expect(isEngineHeldForScheduledInlineFlushForTesting(getInternals(flushed))).toBe(false);
    const flushedHandle = await flushed.start(ECHO_WORKFLOW, 'flushed');
    expect(isEngineHeldForScheduledInlineFlushForTesting(getInternals(flushed))).toBe(true);
    expect(await flushedHandle.result()).toBe('flushed');
    expect(isEngineHeldForScheduledInlineFlushForTesting(getInternals(flushed))).toBe(false);

    await using drained = new Engine({ storage: new MemoryStorage() });
    drained.register(echo);
    const drainedHandle = await drained.start(ECHO_WORKFLOW, 'drained');
    expect(isEngineHeldForScheduledInlineFlushForTesting(getInternals(drained))).toBe(true);
    await drained.flushInlineLaunches();
    expect(isEngineHeldForScheduledInlineFlushForTesting(getInternals(drained))).toBe(false);
    expect(await drainedHandle.result()).toBe('drained');

    const discarded = new Engine({ storage: new MemoryStorage() });
    discarded.register(echo);
    await discarded.start(ECHO_WORKFLOW, 'discarded');
    expect(isEngineHeldForScheduledInlineFlushForTesting(getInternals(discarded))).toBe(true);
    discarded[Symbol.dispose]();
    expect(isEngineHeldForScheduledInlineFlushForTesting(getInternals(discarded))).toBe(false);
  });
});

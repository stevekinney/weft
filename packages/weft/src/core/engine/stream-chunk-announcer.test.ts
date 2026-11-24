import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  advanceTimersByTime,
  restoreRealTimers,
  useFakeTimers,
} from "../../../test-support/embedded/testing/src/fake-timers.ts";
import { StreamChunkEvent } from '../events/fleet-state-events.ts';
import { getWorkflowEventGeneration } from '../events/workflow-event-generation.ts';
import {
  STREAM_CHUNK_EVENT_INTERVAL_MILLISECONDS,
  StreamChunkAnnouncer,
} from './stream-chunk-announcer.ts';

const INTERVAL = STREAM_CHUNK_EVENT_INTERVAL_MILLISECONDS;

/** Collects `[workflowId, key, sequence, token]` for every `stream:chunk` event dispatched. */
function recorder() {
  const seen: Array<[string, string, number, string | undefined]> = [];
  const dispatchEvent = (event: Event) => {
    expect(event).toBeInstanceOf(StreamChunkEvent);
    const { workflowId, key, sequence } = event as StreamChunkEvent;
    seen.push([workflowId, key, sequence, getWorkflowEventGeneration(event)]);
  };
  return { seen, dispatchEvent };
}

function storeBurst(
  announcer: StreamChunkAnnouncer,
  from: number,
  to: number,
  token = 'run-1',
  workflowId = 'wf',
  key = 'progress',
): void {
  for (let sequence = from; sequence <= to; sequence++) {
    announcer.stored(workflowId, key, sequence, token);
  }
}

beforeEach(() => {
  useFakeTimers();
});

afterEach(() => {
  restoreRealTimers();
});

describe('StreamChunkAnnouncer', () => {
  it('collapses a burst into the first chunk and one trailing event naming the highest sequence', async () => {
    const { seen, dispatchEvent } = recorder();
    using announcer = new StreamChunkAnnouncer(dispatchEvent, () => false);

    storeBurst(announcer, 0, 99);
    expect(seen).toEqual([['wf', 'progress', 0, 'run-1']]);

    await advanceTimersByTime(INTERVAL - 1);
    expect(seen).toHaveLength(1);

    await advanceTimersByTime(1);
    expect(seen).toEqual([
      ['wf', 'progress', 0, 'run-1'],
      ['wf', 'progress', 99, 'run-1'],
    ]);

    // The trailing event opened a window; nothing new was stored in it, so it closes silently.
    await advanceTimersByTime(INTERVAL * 4);
    expect(seen).toHaveLength(2);
    expect(announcer.openWindowCount).toBe(0);
  });

  it('emits at most twice per window while a stream keeps writing', async () => {
    const { seen, dispatchEvent } = recorder();
    using announcer = new StreamChunkAnnouncer(dispatchEvent, () => false);

    let next = 0;
    for (let window = 0; window < 5; window++) {
      storeBurst(announcer, next, next + 9);
      next += 10;
      await advanceTimersByTime(INTERVAL);
    }

    // One immediate event, then one trailing event per closed window.
    expect(seen.map(([, , sequence]) => sequence)).toEqual([0, 9, 19, 29, 39, 49]);
  });

  it('announces a lone chunk once and holds no state after its quiet window', async () => {
    const { seen, dispatchEvent } = recorder();
    using announcer = new StreamChunkAnnouncer(dispatchEvent, () => false);

    announcer.stored('wf', 'progress', 0, 'run-1');
    await advanceTimersByTime(INTERVAL);

    expect(seen).toEqual([['wf', 'progress', 0, 'run-1']]);
    expect(announcer.openWindowCount).toBe(0);
  });

  it('coalesces each workflow stream key on its own', () => {
    const { seen, dispatchEvent } = recorder();
    using announcer = new StreamChunkAnnouncer(dispatchEvent, () => false);

    storeBurst(announcer, 0, 3, 'run-1', 'wf', 'progress');
    storeBurst(announcer, 0, 3, 'run-1', 'wf', 'log');
    storeBurst(announcer, 0, 3, 'run-2', 'other', 'progress');

    expect(seen).toEqual([
      ['wf', 'progress', 0, 'run-1'],
      ['wf', 'log', 0, 'run-1'],
      ['other', 'progress', 0, 'run-2'],
    ]);
    expect(announcer.openWindowCount).toBe(3);
  });

  it('settle announces the pending sequence at once and closes the window', async () => {
    const { seen, dispatchEvent } = recorder();
    using announcer = new StreamChunkAnnouncer(dispatchEvent, () => false);

    storeBurst(announcer, 0, 7);
    announcer.settle('wf', 'progress', 'run-1');

    expect(seen.map(([, , sequence]) => sequence)).toEqual([0, 7]);
    expect(announcer.openWindowCount).toBe(0);
    await advanceTimersByTime(INTERVAL * 2);
    expect(seen).toHaveLength(2);
  });

  it('settle adds nothing when the last chunk was the one already announced', () => {
    const { seen, dispatchEvent } = recorder();
    using announcer = new StreamChunkAnnouncer(dispatchEvent, () => false);

    announcer.stored('wf', 'progress', 0, 'run-1');
    announcer.settle('wf', 'progress', 'run-1');

    expect(seen.map(([, , sequence]) => sequence)).toEqual([0]);
    expect(announcer.openWindowCount).toBe(0);
  });

  it('discard drops the pending sequence so a removed chunk is never announced', async () => {
    const { seen, dispatchEvent } = recorder();
    using announcer = new StreamChunkAnnouncer(dispatchEvent, () => false);

    storeBurst(announcer, 0, 5);
    announcer.discard('wf', 'progress', 'run-1');
    await advanceTimersByTime(INTERVAL * 2);

    expect(seen.map(([, , sequence]) => sequence)).toEqual([0]);
    expect(announcer.openWindowCount).toBe(0);
  });

  it('flushWorkflow announces every pending key of the workflow and leaves other workflows alone', async () => {
    const { seen, dispatchEvent } = recorder();
    using announcer = new StreamChunkAnnouncer(dispatchEvent, () => false);

    storeBurst(announcer, 0, 4, 'run-1', 'wf', 'progress');
    storeBurst(announcer, 0, 2, 'run-1', 'wf', 'log');
    storeBurst(announcer, 0, 2, 'run-2', 'other', 'progress');
    seen.length = 0;

    announcer.flushWorkflow('wf');
    expect(seen).toEqual([
      ['wf', 'progress', 4, 'run-1'],
      ['wf', 'log', 2, 'run-1'],
    ]);
    expect(announcer.openWindowCount).toBe(1);

    await advanceTimersByTime(INTERVAL);
    expect(seen.at(-1)).toEqual(['other', 'progress', 2, 'run-2']);
  });

  it('tags a trailing event with the run that stored it, and a new run of the id restarts the key', () => {
    const { seen, dispatchEvent } = recorder();
    using announcer = new StreamChunkAnnouncer(dispatchEvent, () => false);

    storeBurst(announcer, 0, 5, 'old-run');
    // A `start-new` replacement writes the same key: its first chunk is announced at once under its
    // own token, and the old run's pending sequence is never announced.
    announcer.stored('wf', 'progress', 0, 'new-run');
    // The old run's late settle no longer owns the key, so it neither announces nor closes it.
    announcer.settle('wf', 'progress', 'old-run');
    announcer.discard('wf', 'progress', 'old-run');
    announcer.stored('wf', 'progress', 1, 'new-run');
    announcer.settle('wf', 'progress', 'new-run');

    expect(seen).toEqual([
      ['wf', 'progress', 0, 'old-run'],
      ['wf', 'progress', 0, 'new-run'],
      ['wf', 'progress', 1, 'new-run'],
    ]);
  });

  it("ignores a superseded run's late chunk, so it cannot displace the replacement's pending sequence", () => {
    const { seen, dispatchEvent } = recorder();
    const currentToken = 'new-run';
    using announcer = new StreamChunkAnnouncer(
      dispatchEvent,
      (_workflowId, token) => token !== currentToken,
    );

    storeBurst(announcer, 0, 1, 'new-run');
    // The cancelled run's producer outlived it and stores a chunk on the same key.
    announcer.stored('wf', 'progress', 0, 'old-run');
    announcer.settle('wf', 'progress', 'new-run');

    expect(seen).toEqual([
      ['wf', 'progress', 0, 'new-run'],
      ['wf', 'progress', 1, 'new-run'],
    ]);
    expect(announcer.openWindowCount).toBe(0);
  });

  it('disposal cancels every open window without a trailing event and is idempotent', async () => {
    const { seen, dispatchEvent } = recorder();
    const announcer = new StreamChunkAnnouncer(dispatchEvent, () => false);

    storeBurst(announcer, 0, 9);
    announcer[Symbol.dispose]();
    announcer[Symbol.dispose]();
    await advanceTimersByTime(INTERVAL * 2);

    expect(seen.map(([, , sequence]) => sequence)).toEqual([0]);
    expect(announcer.openWindowCount).toBe(0);
  });
});

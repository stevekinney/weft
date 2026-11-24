/**
 * COR-1798: `EventBroadcastingHandle.dispose()` is what a server stop awaits before the host
 * releases the storage under it, so it settles only after every event write already in flight has
 * settled, and no event dispatched afterwards is written at all. The cases cross each state a write
 * can be in at the moment of the call with what `dispose()` must then do.
 */
import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { quietFor, waitUntil } from "../../../test-support/embedded/testing/src/wait-until.ts";
import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import { AlertFiredEvent, WorkflowSuspendedEvent } from '../../core/events.ts';
import { KEYS } from '../../storage/keys.ts';
import type { FleetEventFeed } from '../fleet-event-feed.ts';
import { wireEventBroadcasting, type EventBroadcastingHandle } from './event-broadcasting.ts';

type Gate = { readonly opened: Promise<void>; open(): void };

function createGate(): Gate {
  let open = (): void => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/** Holds every write of a workflow's watch events until the test opens the gate, or rejects it. */
class ControlledWatchStorage extends MemoryStorage {
  gate: Gate | undefined;
  failWith: Error | undefined;
  watchPutAttempts = 0;

  override async put(key: string, value: Uint8Array): Promise<void> {
    if (key.startsWith('watch-event:')) {
      this.watchPutAttempts += 1;
      await this.gate?.opened;
      if (this.failWith) throw this.failWith;
    }
    return super.put(key, value);
  }
}

const noServer = { publish() {} } as never;
const workflowId = 'wf-drain';

async function storedWatchKeys(storage: MemoryStorage): Promise<string[]> {
  const keys: string[] = [];
  for await (const [key] of storage.scan(KEYS.watchEventPrefix(workflowId))) keys.push(key);
  return keys;
}

/** Whether `promise` has settled yet, observed after the event loop has had several turns. */
async function settledAfterQuietPeriod(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await quietFor(50);
  return settled;
}

describe('EventBroadcastingHandle.dispose', () => {
  const engines: Engine[] = [];
  const handles: EventBroadcastingHandle[] = [];

  function wire(
    storage: MemoryStorage,
    fleetEventFeed?: FleetEventFeed,
  ): { engine: Engine; handle: EventBroadcastingHandle } {
    const engine = new Engine({ storage });
    const handle = wireEventBroadcasting(
      engine,
      noServer,
      fleetEventFeed === undefined ? {} : { fleetEventFeed },
    );
    engines.push(engine);
    handles.push(handle);
    return { engine, handle };
  }

  afterEach(async () => {
    for (const handle of handles.splice(0)) await handle.dispose();
    for (const engine of engines.splice(0)) engine[Symbol.dispose]();
  });

  it('returns without waiting on anything when no write is in flight', async () => {
    const { handle } = wire(new ControlledWatchStorage());
    await handle.dispose();
  });

  it('returns only after an event-chain storage write in flight has settled', async () => {
    const storage = new ControlledWatchStorage();
    storage.gate = createGate();
    const { engine, handle } = wire(storage);

    engine.dispatchEvent(new WorkflowSuspendedEvent(workflowId));
    await waitUntil(() => storage.watchPutAttempts === 1, { message: 'the event write to begin' });

    const disposing = handle.dispose();
    expect(await settledAfterQuietPeriod(disposing)).toBe(false);
    expect(await storedWatchKeys(storage)).toEqual([]);

    storage.gate.open();
    await disposing;
    expect(await storedWatchKeys(storage)).toEqual([KEYS.watchEvent(workflowId, 0)]);
  });

  it('returns only after every event queued behind the one in flight has been written', async () => {
    const storage = new ControlledWatchStorage();
    storage.gate = createGate();
    const { engine, handle } = wire(storage);

    engine.dispatchEvent(new WorkflowSuspendedEvent(workflowId));
    engine.dispatchEvent(new WorkflowSuspendedEvent(workflowId));
    await waitUntil(() => storage.watchPutAttempts === 1, { message: 'the first write to begin' });

    const disposing = handle.dispose();
    storage.gate.open();
    await disposing;

    expect(await storedWatchKeys(storage)).toEqual([
      KEYS.watchEvent(workflowId, 0),
      KEYS.watchEvent(workflowId, 1),
    ]);
  });

  it('returns only after a fleet-feed append in flight has settled', async () => {
    const gate = createGate();
    const appended: string[] = [];
    let started = 0;
    const fleetEventFeed = {
      append: async (event: { kind: string }) => {
        started += 1;
        await gate.opened;
        appended.push(event.kind);
      },
      appendWorkflowEventIfPresent: async (event: { kind: string }) => {
        started += 1;
        await gate.opened;
        appended.push(event.kind);
        return null;
      },
    } as unknown as FleetEventFeed;
    const { engine, handle } = wire(new ControlledWatchStorage(), fleetEventFeed);

    // One append belongs to a workflow's event chain, the other is a workflowless event.
    engine.dispatchEvent(new WorkflowSuspendedEvent(workflowId));
    engine.dispatchEvent(new AlertFiredEvent('queue-depth', 10, 11));
    await waitUntil(() => started === 2, { message: 'both fleet appends to begin' });

    const disposing = handle.dispose();
    expect(await settledAfterQuietPeriod(disposing)).toBe(false);
    expect(appended).toEqual([]);

    gate.open();
    await disposing;
    expect(appended.toSorted()).toEqual(
      [AlertFiredEvent.type, WorkflowSuspendedEvent.type].toSorted(),
    );
  });

  it('completes the drain and does not reject when an in-flight write fails after its retry', async () => {
    const storage = new ControlledWatchStorage();
    storage.failWith = new Error('storage refused the write');
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    const warnings = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { engine, handle } = wire(storage);
      engine.dispatchEvent(new WorkflowSuspendedEvent(workflowId));
      await waitUntil(() => storage.watchPutAttempts === 1, { message: 'the write to begin' });

      await handle.dispose();

      expect(storage.watchPutAttempts).toBe(2);
      expect(errors.mock.calls.map(([line]) => String(line))).toEqual([
        `[weft] Failed to persist event "${WorkflowSuspendedEvent.type}" for workflow "${workflowId}":`,
      ]);
    } finally {
      errors.mockRestore();
      warnings.mockRestore();
    }
  });

  it('attempts no write for an event dispatched once disposal has begun', async () => {
    const storage = new ControlledWatchStorage();
    storage.gate = createGate();
    const appended: string[] = [];
    const fleetEventFeed = {
      append: async (event: { kind: string }) => {
        appended.push(event.kind);
      },
      appendWorkflowEventIfPresent: async (event: { kind: string }) => {
        appended.push(event.kind);
        return null;
      },
    } as unknown as FleetEventFeed;
    const { engine, handle } = wire(storage, fleetEventFeed);

    engine.dispatchEvent(new WorkflowSuspendedEvent(workflowId));
    await waitUntil(() => storage.watchPutAttempts === 1, { message: 'the write to begin' });
    const disposing = handle.dispose();

    engine.dispatchEvent(new WorkflowSuspendedEvent(workflowId));
    engine.dispatchEvent(new AlertFiredEvent('queue-depth', 10, 11));
    storage.gate.open();
    await disposing;
    await quietFor(50);

    expect(storage.watchPutAttempts).toBe(1);
    expect(await storedWatchKeys(storage)).toEqual([KEYS.watchEvent(workflowId, 0)]);
    expect(appended).toEqual([WorkflowSuspendedEvent.type]);
  });
});

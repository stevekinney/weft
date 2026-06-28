import { describe, expect, it } from 'bun:test';

import { DEFAULT_SCOPE, KEYS } from '../storage/interface.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { createCoreStorageAdapter } from '../storage/storage-adapter.test-support.ts';
import {
  AtomicState,
  AtomicStateChangeEvent,
  AtomicStateConflictError,
  AtomicStateConflictEvent,
  AtomicStateExhaustedEvent,
  OBSERVABLE_SYMBOL,
  atomicStateDataKey,
  atomicStateVersionKey,
} from './atomic-state.ts';
import { decode } from './codec.ts';

function createStorage() {
  return new MemoryStorage();
}

describe('AtomicState capability gate', () => {
  it('throws a clear diagnostic when the backend lacks conditionalBatch', async () => {
    // createCoreStorageAdapter reports capabilities().conditionalBatch === false.
    using storage = createCoreStorageAdapter();
    const state = new AtomicState<number>(storage, KEYS.stateExecution('wf-1', 'counter'), {
      initial: 0,
    });

    await expect(state.set(1)).rejects.toThrow(
      'Feature "AtomicState compare-and-swap" requires storage capability "conditionalBatch", but this storage backend does not provide it.',
    );
  });

  it('throws on delete() too when the backend lacks conditionalBatch', async () => {
    using storage = createCoreStorageAdapter();
    const state = new AtomicState<number>(storage, KEYS.stateExecution('wf-1', 'counter'), {
      initial: 0,
    });

    await expect(state.delete()).rejects.toThrow(
      'Feature "AtomicState compare-and-swap" requires storage capability "conditionalBatch", but this storage backend does not provide it.',
    );
  });
});

describe('AtomicState', () => {
  it('returns construction initial only before the slot has ever been written', async () => {
    const storage = createStorage();
    const state = new AtomicState<number>(storage, KEYS.stateExecution('wf-1', 'counter'), {
      initial: 5,
    });

    expect(await state.get()).toBe(5);

    await state.set(10);
    expect(await state.get()).toBe(10);

    await state.delete();
    expect(await state.get()).toBeUndefined();
  });

  it('commits updates through storage conditionalBatch', async () => {
    const storage = createStorage();
    const calls: Array<{ conditions: unknown[]; operations: unknown[] }> = [];
    const originalConditionalBatch = storage.conditionalBatch.bind(storage);
    storage.conditionalBatch = async (conditions, operations) => {
      calls.push({ conditions, operations });
      return originalConditionalBatch(conditions, operations);
    };
    const state = new AtomicState<number>(storage, KEYS.stateExecution('wf-1', 'counter'), {
      initial: 0,
    });

    await state.increment();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.conditions).toEqual([
      { key: atomicStateVersionKey(KEYS.stateExecution('wf-1', 'counter')), expectedValue: null },
    ]);
    expect(await state.get()).toBe(1);
  });

  it('keeps a tombstone version on delete so delete participates in CAS', async () => {
    const storage = createStorage();
    const key = KEYS.stateExecution('wf-1', 'counter');
    const state = new AtomicState<number>(storage, key, { initial: 0 });

    await state.set(1);
    await state.delete();

    expect(await storage.get(key)).toBeNull();
    const version = decode((await storage.get(atomicStateVersionKey(key)))!) as number;
    expect(version).toBe(2);
  });

  it('retries conflicts and throws AtomicStateConflictError after exhaustion', async () => {
    const storage = createStorage();
    const key = KEYS.stateExecution('wf-1', 'counter');
    const sleepCalls: number[] = [];
    storage.conditionalBatch = async () => false;
    const state = new AtomicState<number>(storage, key, {
      initial: 0,
      maxRetries: 3,
      sleep: (milliseconds) => {
        sleepCalls.push(milliseconds);
        return Promise.resolve();
      },
    });

    await expect(state.increment()).rejects.toThrow(AtomicStateConflictError);
    expect(sleepCalls).toHaveLength(2);
  });

  it('supports typed convenience methods', async () => {
    const storage = createStorage();

    const counter = new AtomicState<number>(storage, KEYS.stateExecution('wf-1', 'counter'));
    expect(await counter.increment()).toBe(1);
    expect(await counter.decrement(2)).toBe(-1);

    const object = new AtomicState<{ a?: number; b?: number }>(
      storage,
      KEYS.stateExecution('wf-1', 'object'),
    );
    expect(await object.merge({ a: 1 })).toEqual({ a: 1 });
    expect(await object.merge({ b: 2 })).toEqual({ a: 1, b: 2 });

    const list = new AtomicState<string[]>(storage, KEYS.stateExecution('wf-1', 'list'));
    expect(await list.append('a')).toEqual(['a']);
    expect(await list.append('b')).toEqual(['a', 'b']);
    expect(await list.removeFirst()).toBe('a');
    expect(await list.removeLast()).toBe('b');
    expect(await list.get()).toEqual([]);
  });

  it('projects changes through EventTarget, observable, and async iterator', async () => {
    const storage = createStorage();
    const state = new AtomicState<number>(storage, KEYS.stateExecution('wf-1', 'counter'), {
      initial: 0,
    });
    const events: Event[] = [];
    const observableEvents: Event[] = [];
    state.addEventListener('change', (event) => events.push(event));
    const subscription = state[OBSERVABLE_SYMBOL]().subscribe((event) => {
      observableEvents.push(event);
    });
    const iterator = state[Symbol.asyncIterator]();
    const nextEvent = iterator.next();

    await state.increment();
    const iterated = await nextEvent;
    await iterator.return?.();
    subscription.unsubscribe();

    expect(events[0]).toBeInstanceOf(AtomicStateChangeEvent);
    expect((events[0] as AtomicStateChangeEvent<number>).value).toBe(1);
    expect(observableEvents).toHaveLength(1);
    expect(iterated.value).toBeInstanceOf(AtomicStateChangeEvent);
  });

  it('emits conflict and exhausted events', async () => {
    const storage = createStorage();
    const key = KEYS.stateExecution('wf-1', 'counter');
    const state = new AtomicState<number>(storage, key, { initial: 0, maxRetries: 1 });
    const events: Event[] = [];
    state.addEventListener('conflict', (event) => events.push(event));
    state.addEventListener('exhausted', (event) => events.push(event));
    storage.conditionalBatch = async () => false;

    await expect(state.increment()).rejects.toThrow(AtomicStateConflictError);

    expect(events[0]).toBeInstanceOf(AtomicStateConflictEvent);
    expect(events[1]).toBeInstanceOf(AtomicStateExhaustedEvent);
  });
});

// Acceptance-critical invariant: workflow-owned durable state is written under
// a constant default scope prefix, never at the storage root. weft is
// single-tenant, but the scope component is kept so a future re-partition is a
// key rename, not an implicit storage rewrite. If this changes, it must be a
// deliberate, versioned storage format change — not an accident.
describe('workflow-scoped state default-scope invariant', () => {
  it('keys workflow-shared state under state:workflow-scope:<DEFAULT_SCOPE>:, never at root', () => {
    const dataKey = atomicStateDataKey({ type: 'workflow', workflowType: 'invoice' }, 'cursor');
    expect(dataKey).toBe(`state:workflow-scope:${DEFAULT_SCOPE}:invoice:cursor`);
    expect(dataKey.startsWith(`state:workflow-scope:${DEFAULT_SCOPE}:`)).toBe(true);
    // The key must carry the scope component — not collapse to a root-level
    // `state:workflow-scope:invoice:cursor` form.
    expect(dataKey).not.toBe('state:workflow-scope:invoice:cursor');
  });

  it('cannot alias a retired state:workflow:<tenantId>: key even when the tenant id equals DEFAULT_SCOPE', () => {
    // Earlier workflow-shared state was keyed `state:workflow:<tenantId>:...`.
    // A deployment whose tenant id happened to equal DEFAULT_SCOPE ('default')
    // would alias into the current global namespace if we reused the
    // `state:workflow:` prefix. The `state:workflow-scope:` segment makes that
    // structurally impossible: the current key never starts with the retired
    // prefix.
    const dataKey = atomicStateDataKey({ type: 'workflow', workflowType: 'invoice' }, 'cursor');
    const retiredKeyForTenantNamedDefault = `state:workflow:${DEFAULT_SCOPE}:invoice:cursor`;
    expect(dataKey).not.toBe(retiredKeyForTenantNamedDefault);
    expect(dataKey.startsWith('state:workflow:')).toBe(false);
  });

  it('keeps execution-scoped state owner-partitioned and distinct from workflow scope', () => {
    const executionKey = atomicStateDataKey(
      { type: 'execution', ownerWorkflowId: 'wf-1' },
      'cursor',
    );
    expect(executionKey).toBe('state:execution:wf-1:cursor');
    expect(executionKey.startsWith('state:workflow-scope:')).toBe(false);
  });
});

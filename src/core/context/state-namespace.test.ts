/**
 * Drives the {@link WorkflowAtomicStateHandle} generator methods directly,
 * feeding `state-read` / `state-commit` responses into `.next()`. These
 * generators yield `ContextOperationRequest`s that the engine normally
 * fulfills; here a small harness supplies the responses so every method —
 * including the conflict-retry loop and the exhaustion throw — is exercised
 * without a full engine.
 */
import { describe, expect, it } from 'bun:test';

import {
  AtomicStateConflictError,
  type AtomicStateChangeEvent,
  type AtomicStateCommitResult,
  type AtomicStateExhaustedEvent,
  type AtomicStateScope,
  type AtomicStateSnapshot,
} from '../atomic-state.ts';
import type { ContextOperationRequest } from './operation-request.ts';
import { WorkflowAtomicStateHandle } from './state-namespace.ts';

const SCOPE: AtomicStateScope = { type: 'workflow', workflowType: 'demo' };

/**
 * Run a handle generator to completion, answering each yielded request from
 * `responses` in order. Returns the generator's return value and the requests
 * it yielded so tests can assert on the request stream.
 */
function drive<TReturn>(
  generator: Generator<ContextOperationRequest, TReturn, unknown>,
  responses: unknown[],
): { value: TReturn; requests: ContextOperationRequest[] } {
  const requests: ContextOperationRequest[] = [];
  let responseIndex = 0;
  let step = generator.next();
  while (!step.done) {
    requests.push(step.value);
    const response = responses[responseIndex++];
    step = generator.next(response);
  }
  return { value: step.value, requests };
}

function snapshot<T>(value: T | undefined, version: number): AtomicStateSnapshot<T> {
  return { value, version };
}

function commit<T>(
  applied: boolean,
  value: T | undefined,
  version: number,
): AtomicStateCommitResult<T> {
  return { applied, value, version };
}

describe('WorkflowAtomicStateHandle', () => {
  it('get() reads the current value', () => {
    const handle = new WorkflowAtomicStateHandle<number>(SCOPE, 'counter');
    const { value, requests } = drive(handle.get(), [snapshot(7, 3)]);
    expect(value).toBe(7);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.type).toBe('state-read');
  });

  it('set() reads then commits and emits a change event', () => {
    const handle = new WorkflowAtomicStateHandle<number>(SCOPE, 'counter');
    let changed: AtomicStateChangeEvent<number> | undefined;
    handle.addEventListener('change', (event) => {
      changed = event as AtomicStateChangeEvent<number>;
    });

    const { value, requests } = drive(handle.set(42), [snapshot(1, 5), commit(true, 42, 6)]);

    expect(value).toBe(42);
    expect(requests.map((request) => request.type)).toEqual(['state-read', 'state-commit']);
    expect(changed?.value).toBe(42);
    expect(changed?.previousValue).toBe(1);
    expect(changed?.version).toBe(6);
  });

  it('update() retries on a conflict, emitting a conflict event, then succeeds', () => {
    const handle = new WorkflowAtomicStateHandle<number>(SCOPE, 'counter');
    let conflicts = 0;
    handle.addEventListener('conflict', () => {
      conflicts++;
    });

    const { value, requests } = drive(
      handle.update((current) => (current ?? 0) + 1),
      [
        snapshot(0, 1),
        commit(false, undefined, 1), // version moved underneath us → retry
        snapshot(5, 2),
        // The committed `value` is deliberately different from the updater's
        // result (5 + 1 = 6) to prove update() returns the value it computed,
        // not whatever the commit response happens to echo back.
        commit(true, 999, 3),
      ],
    );

    expect(value).toBe(6);
    expect(conflicts).toBe(1);
    expect(requests.map((request) => request.type)).toEqual([
      'state-read',
      'state-commit',
      'state-read',
      'state-commit',
    ]);
  });

  it('update() throws AtomicStateConflictError and emits exhausted after maxRetries', () => {
    const handle = new WorkflowAtomicStateHandle<number>(SCOPE, 'counter', { maxRetries: 2 });
    let exhausted: AtomicStateExhaustedEvent | undefined;
    handle.addEventListener('exhausted', (event) => {
      exhausted = event as AtomicStateExhaustedEvent;
    });

    const generator = handle.update((current) => (current ?? 0) + 1);
    // Two failed attempts (read + failed commit each), then the throw.
    const responses = [
      snapshot(0, 1),
      commit(false, undefined, 1),
      snapshot(0, 2),
      commit(false, undefined, 2),
    ];
    expect(() => drive(generator, responses)).toThrow(AtomicStateConflictError);
    expect(exhausted?.attempts).toBe(2);
  });

  it('delete() commits a delete and emits a change to undefined', () => {
    const handle = new WorkflowAtomicStateHandle<number>(SCOPE, 'counter');
    let changed: AtomicStateChangeEvent<number> | undefined;
    handle.addEventListener('change', (event) => {
      changed = event as AtomicStateChangeEvent<number>;
    });

    const { requests } = drive(handle.delete(), [snapshot(9, 4), commit(true, undefined, 5)]);

    expect(requests.map((request) => request.type)).toEqual(['state-read', 'state-commit']);
    const deleteCommit = requests[1] as Extract<ContextOperationRequest, { type: 'state-commit' }>;
    expect(deleteCommit.mode).toBe('delete');
    expect(changed?.value).toBeUndefined();
    expect(changed?.previousValue).toBe(9);
  });

  it('delete() retries on conflict then throws after exhaustion', () => {
    const handle = new WorkflowAtomicStateHandle<number>(SCOPE, 'counter', { maxRetries: 1 });
    let conflicts = 0;
    let exhausted = false;
    handle.addEventListener('conflict', () => conflicts++);
    handle.addEventListener('exhausted', () => {
      exhausted = true;
    });

    expect(() => drive(handle.delete(), [snapshot(1, 1), commit(false, undefined, 1)])).toThrow(
      AtomicStateConflictError,
    );
    expect(conflicts).toBe(1);
    expect(exhausted).toBe(true);
  });

  it('increment() adds to the current value (defaulting from undefined)', () => {
    const handle = new WorkflowAtomicStateHandle<number>(SCOPE, 'counter');
    const { value } = drive(handle.increment(3), [snapshot(undefined, 0), commit(true, 3, 1)]);
    expect(value).toBe(3);
  });

  it('increment() defaults its amount to 1', () => {
    const handle = new WorkflowAtomicStateHandle<number>(SCOPE, 'counter');
    const { value } = drive(handle.increment(), [snapshot(4, 1), commit(true, 5, 2)]);
    expect(value).toBe(5);
  });

  it('decrement() subtracts from the current value', () => {
    const handle = new WorkflowAtomicStateHandle<number>(SCOPE, 'counter');
    const { value } = drive(handle.decrement(2), [snapshot(10, 1), commit(true, 8, 2)]);
    expect(value).toBe(8);
  });

  it('decrement() defaults its amount to 1 and treats undefined as 0', () => {
    const handle = new WorkflowAtomicStateHandle<number>(SCOPE, 'counter');
    const { value } = drive(handle.decrement(), [snapshot(undefined, 0), commit(true, -1, 1)]);
    expect(value).toBe(-1);
  });

  it('merge() shallow-merges a patch onto the current object', () => {
    const handle = new WorkflowAtomicStateHandle<{ a: number; b: number }>(SCOPE, 'obj');
    const { value } = drive(handle.merge({ b: 2 }), [
      snapshot({ a: 1, b: 0 }, 1),
      commit(true, { a: 1, b: 2 }, 2),
    ]);
    expect(value).toEqual({ a: 1, b: 2 });
  });

  it('merge() starts from an empty object when current is undefined', () => {
    const handle = new WorkflowAtomicStateHandle<{ a: number }>(SCOPE, 'obj');
    const { value, requests } = drive(handle.merge({ a: 9 }), [
      snapshot(undefined, 0),
      commit(true, { a: 9 }, 1),
    ]);
    expect(value).toEqual({ a: 9 });
    // The updater's result is also carried on the commit request itself.
    const commitRequest = requests[1] as Extract<ContextOperationRequest, { type: 'state-commit' }>;
    expect(commitRequest.value).toEqual({ a: 9 });
  });

  it('append() pushes an item onto the current array', () => {
    const handle = new WorkflowAtomicStateHandle<number[]>(SCOPE, 'list');
    const { value } = drive(handle.append(3), [snapshot([1, 2], 1), commit(true, [1, 2, 3], 2)]);
    expect(value).toEqual([1, 2, 3]);
  });

  it('append() starts from an empty array when current is undefined', () => {
    const handle = new WorkflowAtomicStateHandle<number[]>(SCOPE, 'list');
    const { value } = drive(handle.append(1), [snapshot(undefined, 0), commit(true, [1], 1)]);
    expect(value).toEqual([1]);
  });

  it('removeFirst() shifts and returns the head item', () => {
    const handle = new WorkflowAtomicStateHandle<number[]>(SCOPE, 'list');
    const { value } = drive(handle.removeFirst(), [
      snapshot([1, 2, 3], 1),
      commit(true, [2, 3], 2),
    ]);
    expect(value).toBe(1);
  });

  it('removeFirst() returns undefined for an empty/absent array', () => {
    const handle = new WorkflowAtomicStateHandle<number[]>(SCOPE, 'list');
    const { value } = drive(handle.removeFirst(), [snapshot(undefined, 0), commit(true, [], 1)]);
    expect(value).toBeUndefined();
  });

  it('removeLast() pops and returns the tail item', () => {
    const handle = new WorkflowAtomicStateHandle<number[]>(SCOPE, 'list');
    const { value } = drive(handle.removeLast(), [snapshot([1, 2, 3], 1), commit(true, [1, 2], 2)]);
    expect(value).toBe(3);
  });

  it('removeLast() returns undefined for an empty/absent array', () => {
    const handle = new WorkflowAtomicStateHandle<number[]>(SCOPE, 'list');
    const { value } = drive(handle.removeLast(), [snapshot(undefined, 0), commit(true, [], 1)]);
    expect(value).toBeUndefined();
  });
});

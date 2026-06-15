import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { waitForCondition } from '../../testing/fake-timers.test-support.ts';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { decode } from '../codec.ts';
import { Engine } from '../engine.ts';
import { PayloadSizeExceededError } from '../payload-size.ts';
import type { WorkflowContext } from '../types.ts';
import { workflow } from '../types.ts';
import { recordFinalizerState } from './finalizer-state.ts';
import { getInternals } from './internals.ts';
import { cleanupWorkflowStorage } from './termination/cleanup.ts';

describe('recordFinalizerState', () => {
  it('stages the value as a pending atomic side-effect keyed by the workflow', () => {
    const engine = new Engine();
    const internals = getInternals(engine);
    const workflowId = 'provision-1';

    recordFinalizerState(internals, workflowId, { sandboxId: 'sbx-42' });

    const pending = internals.pendingAtomicWorkflowCommitSideEffects.get(workflowId);
    expect(pending).toBeDefined();
    expect(pending?.conditions).toEqual([]);
    expect(pending?.operations).toHaveLength(1);
    const [operation] = pending!.operations;
    expect(operation?.type).toBe('put');
    expect(operation?.key).toBe(KEYS.finalizerState(workflowId));
    expect(operation?.type === 'put' ? decode(operation.value) : undefined).toEqual({
      sandboxId: 'sbx-42',
    });

    engine[Symbol.dispose]();
  });

  it('last-write-wins: a later call appends a second op so the latest value is what commits', () => {
    // Pending side-effects accumulate; the next checkpoint/terminal commit replays
    // both puts to the same key in order, so the last staged value is the durable one.
    const engine = new Engine();
    const internals = getInternals(engine);
    const workflowId = 'provision-2';

    recordFinalizerState(internals, workflowId, { sandboxId: 'first' });
    recordFinalizerState(internals, workflowId, { sandboxId: 'second' });

    const pending = internals.pendingAtomicWorkflowCommitSideEffects.get(workflowId);
    expect(pending?.operations).toHaveLength(2);
    const lastOperation = pending!.operations.at(-1);
    expect(lastOperation?.type === 'put' ? decode(lastOperation.value) : undefined).toEqual({
      sandboxId: 'second',
    });

    engine[Symbol.dispose]();
  });

  it('preserves null as a distinct recorded value (presence without a payload)', () => {
    const engine = new Engine();
    const internals = getInternals(engine);
    const workflowId = 'provision-null';

    recordFinalizerState(internals, workflowId, null);

    const operation =
      internals.pendingAtomicWorkflowCommitSideEffects.get(workflowId)?.operations[0];
    expect(operation?.type === 'put' ? decode(operation.value) : 'absent').toBeNull();

    engine[Symbol.dispose]();
  });

  it('rejects an oversized payload before staging anything', () => {
    const engine = new Engine({ payloadSize: { maxBytes: 8 } });
    const internals = getInternals(engine);
    const workflowId = 'provision-oversized';

    expect(() =>
      recordFinalizerState(internals, workflowId, { sandboxId: 'a-very-long-sandbox-identifier' }),
    ).toThrow(PayloadSizeExceededError);
    expect(internals.pendingAtomicWorkflowCommitSideEffects.has(workflowId)).toBe(false);

    engine[Symbol.dispose]();
  });

  describe('after the workflow has begun terminalizing', () => {
    let warnSpy: ReturnType<typeof spyOn<typeof console, 'warn'>>;

    beforeEach(() => {
      warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it('is a no-op (the staged op would have no commit to ride) and warns in development', () => {
      const engine = new Engine({ development: true });
      const internals = getInternals(engine);
      const workflowId = 'provision-terminalizing';
      internals.terminalizingWorkflows.add(workflowId);
      // Ignore any construction-time development warnings; count only the
      // warning emitted by the call under test.
      warnSpy.mockClear();

      recordFinalizerState(internals, workflowId, { sandboxId: 'too-late' });

      expect(internals.pendingAtomicWorkflowCommitSideEffects.has(workflowId)).toBe(false);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toContain(workflowId);

      engine[Symbol.dispose]();
    });

    it('stays silent outside development mode', () => {
      const engine = new Engine({ development: false });
      const internals = getInternals(engine);
      const workflowId = 'provision-terminalizing-prod';
      internals.terminalizingWorkflows.add(workflowId);
      // Isolate the call under test from any construction-time warnings.
      warnSpy.mockClear();

      recordFinalizerState(internals, workflowId, { sandboxId: 'too-late' });

      expect(internals.pendingAtomicWorkflowCommitSideEffects.has(workflowId)).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();

      engine[Symbol.dispose]();
    });

    it('ignores an OVERSIZED late call without throwing (guard precedes the size check)', () => {
      // A late `onCancel`-handler call with an oversized payload must still be the
      // documented no-op, NOT a PayloadSizeExceededError thrown into the
      // cancellation-teardown path. The terminalizing guard runs before payload
      // validation. (Development mode here only to assert the warning fires.)
      const engine = new Engine({ payloadSize: { maxBytes: 8 }, development: true });
      const internals = getInternals(engine);
      const workflowId = 'provision-terminalizing-oversized';
      internals.terminalizingWorkflows.add(workflowId);
      warnSpy.mockClear();

      expect(() =>
        recordFinalizerState(internals, workflowId, {
          sandboxId: 'a-very-long-sandbox-identifier',
        }),
      ).not.toThrow();
      expect(internals.pendingAtomicWorkflowCommitSideEffects.has(workflowId)).toBe(false);
      expect(warnSpy).toHaveBeenCalledTimes(1);

      engine[Symbol.dispose]();
    });

    it('ignores an oversized late call silently outside development mode', () => {
      const engine = new Engine({ payloadSize: { maxBytes: 8 }, development: false });
      const internals = getInternals(engine);
      const workflowId = 'provision-terminalizing-oversized-prod';
      internals.terminalizingWorkflows.add(workflowId);
      warnSpy.mockClear();

      expect(() =>
        recordFinalizerState(internals, workflowId, {
          sandboxId: 'a-very-long-sandbox-identifier',
        }),
      ).not.toThrow();
      expect(internals.pendingAtomicWorkflowCommitSideEffects.has(workflowId)).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();

      engine[Symbol.dispose]();
    });
  });

  describe('orphan cleanup via cleanupWorkflowStorage', () => {
    it('sweeps the finalizer-state key (a completed/failed run never runs its finalizer)', async () => {
      // The recorded value is committed durably during the run; a completed or
      // failed workflow never drives its finalizer, so terminal cleanup must
      // sweep the key rather than leak it. Drive the durable cleanup directly —
      // it is what the deferred terminal-cleanup timer eventually calls — mirroring
      // the `workflowHasServices` sweep precedent.
      const storage = new MemoryStorage();
      const engine = new Engine({ storage });

      const provision = workflow({ name: 'finalizer-orphan' }).execute(async function* (
        ctx: WorkflowContext,
      ) {
        ctx.setFinalizerState({ sandboxId: 'sbx-orphan' });
        yield* ctx.waitForSignal('never');
      });
      engine.register(provision);

      const handle = await engine.start('finalizer-orphan', null, { id: 'finalizer-orphan-run' });
      // Wait for the suspend commit to flush the staged value to storage — a
      // deterministic bounded poll, not a fixed sleep-before-assert.
      await waitForCondition(
        async () => (await storage.get(KEYS.finalizerState('finalizer-orphan-run'))) !== null,
        {
          label: 'finalizer state to be committed after the workflow parks',
          timeoutMs: 400,
          intervalMs: 5,
        },
      );

      expect(await storage.get(KEYS.finalizerState('finalizer-orphan-run'))).not.toBeNull();

      await cleanupWorkflowStorage(getInternals(engine), 'finalizer-orphan-run', false);
      expect(await storage.get(KEYS.finalizerState('finalizer-orphan-run'))).toBeNull();

      await engine.cancel(handle.id).catch(() => undefined);
      engine[Symbol.dispose]();
    });
  });
});

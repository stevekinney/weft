import { describe, expect, it } from 'bun:test';
import { sleepForTesting } from '../../testing/fake-timers.test-support.ts';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { deserializeCheckpoint } from '../checkpoint.ts';
import { encode } from '../codec.ts';
import { Engine } from '../engine.ts';
import { validateSessionStateLocals } from '../session-state.ts';
import type { WorkflowContext } from '../types.ts';
import { workflow } from '../types.ts';

async function flush(): Promise<void> {
  await sleepForTesting(10);
}

describe('Acceptance criterion: Virtual-Object-style session state', () => {
  it('persists session state in checkpoint locals and restores it after recovery', async () => {
    const storage = new MemoryStorage();

    function createWorkflow() {
      return async function* (ctx: WorkflowContext) {
        const session = ctx.state.session<number>('counter', { initial: 0 });

        session.update((current) => (current ?? 0) + 1);
        const beforeRecovery = session.get();

        yield* ctx.waitForSignal('resume');

        const afterRecovery = session.update((current) => (current ?? 0) + 1);
        return { beforeRecovery, afterRecovery };
      };
    }

    const engine1 = new Engine({ storage });
    const sessionStateWorkflowWorkflow = workflow({ name: 'session-state-workflow' }).execute(
      createWorkflow(),
    );
    engine1.register(sessionStateWorkflowWorkflow);

    await engine1.start('session-state-workflow', null, { id: 'wf-session-state' });
    await flush();

    const checkpointBeforeCrash = deserializeCheckpoint(
      (await storage.get(KEYS.checkpoint('wf-session-state')))!,
    );
    expect(checkpointBeforeCrash.locals).toEqual({
      stateSession: {
        counter: 1,
      },
    });

    engine1[Symbol.dispose]();

    const engine2 = new Engine({ storage });
    const sessionStateWorkflowWorkflow2 = workflow({ name: 'session-state-workflow' }).execute(
      createWorkflow(),
    );
    engine2.register(sessionStateWorkflowWorkflow2);

    const handles = await engine2.recoverAll();
    expect(handles).toHaveLength(1);

    await engine2.signal('wf-session-state', 'resume');
    await flush();

    const result = await handles[0]!.result();
    expect(result).toEqual({
      beforeRecovery: 1,
      afterRecovery: 2,
    });

    engine2[Symbol.dispose]();
  });

  it('keeps cleared state absent across checkpointing and recovery until a write occurs', async () => {
    const storage = new MemoryStorage();

    function createWorkflow() {
      return async function* (ctx: WorkflowContext) {
        const session = ctx.state.session<number>('counter', { initial: 0 });

        session.set(1);
        session.delete();
        const afterClear = session.get();

        yield* ctx.waitForSignal('resume');

        const afterRecovery = session.get();
        const afterWrite = session.update((current) => (current ?? 0) + 1);
        return { afterClear, afterRecovery, afterWrite };
      };
    }

    const engine1 = new Engine({ storage });
    const sessionStateClearWorkflowWorkflow = workflow({
      name: 'session-state-clear-workflow',
    }).execute(createWorkflow());
    engine1.register(sessionStateClearWorkflowWorkflow);

    await engine1.start('session-state-clear-workflow', null, { id: 'wf-session-state-clear' });
    await flush();

    const checkpointBeforeCrash = deserializeCheckpoint(
      (await storage.get(KEYS.checkpoint('wf-session-state-clear')))!,
    );
    expect(checkpointBeforeCrash.locals).toEqual({});

    engine1[Symbol.dispose]();

    const engine2 = new Engine({ storage });
    const sessionStateClearWorkflowWorkflow2 = workflow({
      name: 'session-state-clear-workflow',
    }).execute(createWorkflow());
    engine2.register(sessionStateClearWorkflowWorkflow2);

    const handles = await engine2.recoverAll();
    expect(handles).toHaveLength(1);

    await engine2.signal('wf-session-state-clear', 'resume');
    await flush();

    const result = await handles[0]!.result();
    expect(result).toEqual({
      afterClear: 0,
      afterRecovery: 0,
      afterWrite: 1,
    });

    engine2[Symbol.dispose]();
  });

  it('rejects corrupted checkpoint locals that use reserved session-state keys', () => {
    const stateSession = Object.create(null) as Record<string, unknown>;
    stateSession['constructor'] = {
      polluted: true,
    };
    const corruptedCheckpoint = encode({
      workflowId: 'wf-corrupted-session-state',
      step: 1,
      locals: {
        stateSession,
      },
      accumulatedResults: [],
      pendingSignals: [],
      searchAttributes: {},
      version: '1.0.0',
      createdAt: Date.now(),
    });

    expect(() => deserializeCheckpoint(corruptedCheckpoint)).toThrow();
  });

  it('ignores the retired checkpoint-local sessionState key during recovery', () => {
    const retiredState = Object.create(null) as Record<string, unknown>;
    retiredState['__proto__'] = 1;

    expect(() =>
      validateSessionStateLocals({
        sessionState: {
          counter: 1,
        },
      }),
    ).not.toThrow();

    expect(() =>
      validateSessionStateLocals({
        sessionState: retiredState,
      }),
    ).not.toThrow();
  });

  it('rejects corrupted checkpoint locals whose session-state root is not a plain object', () => {
    for (const stateSession of [new Date(), new Map<string, number>([['count', 1]])]) {
      const corruptedCheckpoint = encode({
        workflowId: 'wf-corrupted-session-state-root',
        step: 1,
        locals: {
          stateSession,
        },
        accumulatedResults: [],
        pendingSignals: [],
        searchAttributes: {},
        version: '1.0.0',
        createdAt: Date.now(),
      });

      expect(() => deserializeCheckpoint(corruptedCheckpoint)).toThrow();
    }
  });

  it('rejects custom class instances at the session-state validation boundary', () => {
    class SessionStateRoot {
      count = 1;
    }

    expect(() =>
      validateSessionStateLocals({
        stateSession: new SessionStateRoot(),
      }),
    ).toThrow();
  });
});

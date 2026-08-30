import { describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine.ts';
import { nextAsyncPendingToken } from '../testing/async-activity.test-support.ts';
import {
  clientContractAsyncActivityWorkflow,
  clientContractEchoWorkflow,
  clientContractWaitingObjectWorkflow,
  clientContractWaitingTwiceWorkflow,
  clientContractWaitingWorkflow,
  waitForHandleEventForTesting,
  waitForQueryReadyForTesting,
} from './client-contract.test-support.ts';

describe('client contract test support', () => {
  it('retries query readiness until the workflow reports ready', async () => {
    let attempts = 0;
    const client = {
      query: async () => {
        attempts += 1;
        return attempts >= 3;
      },
    };

    await expect(
      waitForQueryReadyForTesting(client as never, 'workflow-ready'),
    ).resolves.toBeUndefined();
    expect(attempts).toBe(3);
  });

  it('throws when query handlers never become ready', async () => {
    const client = {
      query: async () => false,
    };

    await expect(waitForQueryReadyForTesting(client as never, 'workflow-stuck')).rejects.toThrow(
      'Workflow workflow-stuck did not expose query handlers',
    );
  });

  it('times out when a handle event never arrives', async () => {
    const handle = {
      addEventListener: () => {},
    };

    await expect(waitForHandleEventForTesting(handle, 'workflow:completed', 1)).rejects.toThrow(
      'workflow event "workflow:completed" did not arrive within 1ms',
    );
  });

  it('resolves when the requested handle event arrives', async () => {
    let listener: ((event: Event) => void) | undefined;
    const handle = {
      addEventListener: (_type: string, attached: (event: Event) => void) => {
        listener = attached;
      },
    };

    const eventPromise = waitForHandleEventForTesting(handle, 'workflow:completed', 50);
    listener?.(new Event('workflow:completed'));

    await expect(eventPromise).resolves.toBeInstanceOf(Event);
  });

  it('round-trips the echo workflow result', async () => {
    const engine = new Engine();
    try {
      engine.register(clientContractEchoWorkflow);

      const handle = await engine.start('client-contract-echo', { hello: 'world' });

      await expect(handle.result()).resolves.toEqual({ hello: 'world' });
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('exercises the waiting workflow query, update, and signal callbacks', async () => {
    const engine = new Engine();
    try {
      engine.register(clientContractWaitingWorkflow);
      const queryReadyClient = {
        query: engine.query.bind(engine),
      } as never;

      const handle = await engine.start('client-contract-waiting', 'payload');
      await waitForQueryReadyForTesting(queryReadyClient, handle.id);

      await expect(handle.query('echoInput', { detail: true })).resolves.toEqual({ detail: true });
      await expect(handle.update('rename', { next: 'value' })).resolves.toEqual({
        accepted: true,
        input: 'payload',
        payload: { next: 'value' },
      });

      await handle.signal('continue', 'done');
      await expect(handle.result()).resolves.toBe('payload:done');
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('waits for two continue signals before completing', async () => {
    const engine = new Engine();
    try {
      engine.register(clientContractWaitingTwiceWorkflow);
      const queryReadyClient = {
        query: engine.query.bind(engine),
      } as never;

      const handle = await engine.start('client-contract-waiting-twice', 'twice');
      await waitForQueryReadyForTesting(queryReadyClient, handle.id);

      await handle.signal('continue');
      await expect(engine.get(handle.id)).resolves.toMatchObject({ status: 'running' });
      await handle.signal('continue');
      await expect(handle.result()).resolves.toBe('twice:done');
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('round-trips the object signal payload', async () => {
    const engine = new Engine();
    try {
      engine.register(clientContractWaitingObjectWorkflow);
      const queryReadyClient = {
        query: engine.query.bind(engine),
      } as never;

      const handle = await engine.start('client-contract-waiting-object', 'object');
      await waitForQueryReadyForTesting(queryReadyClient, handle.id);

      await handle.signal('object-signal', { signalId: 'abc123' });
      await expect(handle.result()).resolves.toBe('object:abc123');
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('resumes the async activity workflow with an externally completed result', async () => {
    const engine = new Engine();
    try {
      engine.register(clientContractAsyncActivityWorkflow);

      const tokenPromise = nextAsyncPendingToken(engine);
      const handle = await engine.start('client-contract-async-activity', 'async-input');
      const token = await tokenPromise;

      await engine.completeAsyncActivity(token, { approved: true });
      await expect(handle.result()).resolves.toEqual({
        input: 'async-input',
        resolved: { approved: true },
      });
    } finally {
      engine[Symbol.dispose]();
    }
  });
});

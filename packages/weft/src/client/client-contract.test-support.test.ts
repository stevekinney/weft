import { describe, expect, it } from 'bun:test';

import { Engine } from '../core/engine.ts';
import { nextAsyncPendingToken } from '../testing/async-activity.test-support.ts';
import { throwingRejectionOf } from '../testing/promise-outcome.test-support.ts';
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

    expect(await waitForQueryReadyForTesting(client as never, 'workflow-ready')).toBeUndefined();
    expect(attempts).toBe(3);
  });

  it('throws when query handlers never become ready', async () => {
    const client = {
      query: async () => false,
    };

    expect(
      await throwingRejectionOf(waitForQueryReadyForTesting(client as never, 'workflow-stuck')),
    ).toThrow('Workflow workflow-stuck did not expose query handlers');
  });

  it('times out when a handle event never arrives', async () => {
    const handle = {
      addEventListener: () => {},
    };

    expect(
      await throwingRejectionOf(waitForHandleEventForTesting(handle, 'workflow:completed', 1)),
    ).toThrow('workflow event "workflow:completed" did not arrive within 1ms');
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

    expect(await eventPromise).toBeInstanceOf(Event);
  });

  it('round-trips the echo workflow result', async () => {
    const engine = new Engine();
    try {
      engine.register(clientContractEchoWorkflow);

      const handle = await engine.start('client-contract-echo', { hello: 'world' });

      expect(await handle.result()).toEqual({ hello: 'world' });
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

      expect(await handle.query('echoInput', { detail: true })).toEqual({ detail: true });
      expect(await handle.update('rename', { next: 'value' })).toEqual({
        accepted: true,
        input: 'payload',
        payload: { next: 'value' },
      });

      await handle.signal('continue', 'done');
      expect(await handle.result()).toBe('payload:done');
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
      expect(await engine.get(handle.id)).toMatchObject({ status: 'running' });
      await handle.signal('continue');
      expect(await handle.result()).toBe('twice:done');
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
      expect(await handle.result()).toBe('object:abc123');
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
      expect(await handle.result()).toEqual({
        input: 'async-input',
        resolved: { approved: true },
      });
    } finally {
      engine[Symbol.dispose]();
    }
  });
});

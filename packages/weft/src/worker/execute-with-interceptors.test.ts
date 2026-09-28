import { describe, expect, it } from 'bun:test';

import { executeWithInterceptors } from './execute-with-interceptors.ts';

describe('executeWithInterceptors', () => {
  it('omits the activity execution context when there is no signal or execution token state', async () => {
    let receivedContext:
      | {
          signal: AbortSignal;
          workflowExecutionToken?: string;
          activityAttemptToken?: string;
        }
      | undefined;

    const result = await executeWithInterceptors(
      async (_input, context) => {
        receivedContext = context;
        return 'done';
      },
      {
        activityName: 'charge',
        operationId: 'op-no-context',
        input: { amount: 42 },
        attemptToken: 'attempt-token',
      },
      null,
    );

    expect(result).toBe('done');
    expect(receivedContext).toBeUndefined();
  });

  it('provides a harmless no-op heartbeat() when no sendHeartbeat callback is supplied (COR-226)', async () => {
    const controller = new AbortController();
    let heartbeatThrew = false;

    await executeWithInterceptors(
      async (_input, context) => {
        try {
          context?.heartbeat({ progress: 1 });
        } catch {
          heartbeatThrew = true;
        }
        return 'done';
      },
      {
        activityName: 'charge',
        operationId: 'op-no-send-heartbeat',
        input: { amount: 42 },
        attemptToken: 'attempt-token',
      },
      null,
      controller.signal,
      // No `sendHeartbeat` argument — a context is still returned (a signal
      // is present), and its `heartbeat()` must be safely callable rather
      // than throwing or being `undefined`.
    );

    expect(heartbeatThrew).toBe(false);
  });
});

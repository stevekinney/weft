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
      },
      null,
    );

    expect(result).toBe('done');
    expect(receivedContext).toBeUndefined();
  });
});

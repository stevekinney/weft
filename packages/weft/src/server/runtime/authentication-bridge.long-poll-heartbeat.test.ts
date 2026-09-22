/**
 * COR-1283: `handleServerFetchRequest`'s long-poll `/v1/tasks/<queue>/heartbeat`
 * branch (`authentication-bridge.ts`) is otherwise only exercised through
 * `handleTaskHeartbeatRequest` directly (`task-heartbeat.test.ts`), never
 * through the real dispatcher this handler wires it into. Drives a genuine
 * long-poll claim, then a genuine heartbeat, through a live `serve()` server.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { Engine } from '../../core/engine.ts';
import { activity, workflow } from '../../core/types.ts';
import { serve, type WeftServer } from '../index.ts';

describe('long-poll activity heartbeat through the real HTTP dispatcher', () => {
  let engine: Engine | undefined;
  let server: WeftServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('renews a long-poll-claimed attempt lease via POST /v1/tasks/<queue>/heartbeat', async () => {
    engine = new Engine({ activityExecution: { mode: 'remote' } });
    server = serve({ engine, port: 0, unauthenticatedAccess: 'allow' });

    const formatGreeting = activity({
      name: 'formatGreeting',
      execute: async (_input: { name: string }): Promise<string> => {
        throw new Error('local execution must never run in remote mode');
      },
    });
    engine.register(
      workflow({ name: 'long-poll-heartbeat-workflow' })
        .activities({ formatGreeting })
        .execute(async function* (context, input: { name: string }) {
          return yield* context.run(formatGreeting, input);
        }),
    );

    void engine.start(
      'long-poll-heartbeat-workflow',
      { name: 'Ada' },
      { id: 'long-poll-heartbeat-1' },
    );

    // Activity names on the wire are namespaced by workflow type
    // (`<workflowType>.<activityName>`).
    const pollResponse = await fetch(
      `${server.url}/v1/tasks/default?activity=long-poll-heartbeat-workflow.formatGreeting&timeout=5000`,
    );
    expect(pollResponse.status).toBe(200);
    const claimed = (await pollResponse.json()) as {
      operationId: string;
      workerId: string;
      attemptToken: string;
    };
    expect(claimed.operationId).toBeString();
    expect(claimed.attemptToken).toBeString();

    const heartbeatResponse = await fetch(`${server.url}/v1/tasks/default/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operationId: claimed.operationId,
        workerId: claimed.workerId,
        attemptToken: claimed.attemptToken,
      }),
    });

    expect(heartbeatResponse.status).toBe(200);
    const heartbeatBody = (await heartbeatResponse.json()) as { ok: boolean };
    expect(heartbeatBody.ok).toBe(true);
  });
});

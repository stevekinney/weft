/**
 * `RemoteWorker` against a scripted WebSocket server that sends what a healthy Weft server never
 * does: frames that are not JSON or are malformed, a protocol error that names no buffered result,
 * and (in the last test) a registration that finds its buffered results cannot all be flushed.
 */

import {
  createDeferred,
  restoreRealTimers,
  waitForCondition,
} from "../../test-support/embedded/testing/src/fake-timers.ts";
import { rejectionOf } from "../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { RemoteWorker } from './index.ts';
import type { RemoteWorkerActivityFunction } from './workflow-activity-binding.ts';

type ScriptedServer = {
  readonly server: ReturnType<typeof Bun.serve>;
  readonly received: Array<Record<string, unknown>>;
  readonly upgradeHeaders: Headers[];
};

/** Accepts every registration, then runs `afterRegister` so a test can script what follows. */
function scriptedServer(
  afterRegister: (ws: Bun.ServerWebSocket<unknown>) => void = () => {},
): ScriptedServer {
  const received: Array<Record<string, unknown>> = [];
  const upgradeHeaders: Headers[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request, bunServer) {
      upgradeHeaders.push(request.headers);
      return bunServer.upgrade(request, { data: undefined }) ? undefined : new Response('ok');
    },
    websocket: {
      message(ws, message) {
        const parsed = JSON.parse(String(message)) as Record<string, unknown>;
        received.push(parsed);
        if (parsed['type'] !== 'register') return;
        ws.send(
          JSON.stringify({
            type: 'registerAck',
            protocolVersion: 8,
            workerId: parsed['workerId'],
            queue: 'default',
            concurrency: 10,
            acceptedManifestDigest: 'sha256:test-accepted-digest',
            serverCapabilities: [],
            sessionGeneration: 1,
          }),
        );
        afterRegister(ws);
      },
    },
  });
  return { server, received, upgradeHeaders };
}

function createWorker(
  scripted: ScriptedServer,
  extra: Partial<ConstructorParameters<typeof RemoteWorker>[0]> = {},
  activities: Record<string, RemoteWorkerActivityFunction> = {
    echo: async (input) => input,
  },
): RemoteWorker {
  return new RemoteWorker({
    serverUrl: `ws://localhost:${scripted.server.port}`,
    deploymentName: 'test-deployment',
    buildId: 'test-build',
    workflows: { orders: { name: 'orders', activities } },
    ...extra,
  });
}

describe('RemoteWorker server frames', () => {
  let scripted: ScriptedServer | undefined;
  let worker: RemoteWorker | undefined;

  afterEach(() => {
    restoreRealTimers();
    worker?.[Symbol.dispose]();
    worker = undefined;
    void scripted?.server.stop(true);
    scripted = undefined;
  });

  it('sends the configured headers with the WebSocket upgrade', async () => {
    scripted = scriptedServer();
    worker = createWorker(scripted, { headers: { authorization: 'Bearer worker-token' } });

    await worker.connect();

    expect(scripted.upgradeHeaders[0]?.get('authorization')).toBe('Bearer worker-token');
  });

  it('ignores a frame that is not JSON and warns about it', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      scripted = scriptedServer((ws) => ws.send('this is not json'));
      worker = createWorker(scripted);

      await worker.connect();
      await waitForCondition(() => warnSpy.mock.calls.length > 0, { label: 'warning logged' });

      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('Received non-JSON server message');
      expect(worker.connected).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('ignores a malformed frame of a known type and warns about it', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      scripted = scriptedServer((ws) => ws.send(JSON.stringify({ type: 'task' })));
      worker = createWorker(scripted);

      await worker.connect();
      await waitForCondition(() => warnSpy.mock.calls.length > 0, { label: 'warning logged' });

      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('Received malformed server message');
      expect(worker.connected).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('skips a frame of an unknown type silently and carries on with the next frame', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      scripted = scriptedServer((ws) => {
        ws.send(JSON.stringify({ type: 'from-the-future' }));
        ws.send(JSON.stringify({ type: 'task' }));
      });
      worker = createWorker(scripted);

      await worker.connect();
      await waitForCondition(() => warnSpy.mock.calls.length > 0, { label: 'warning logged' });

      // Frames are handled in order, so the only warning is the malformed frame after the unknown one.
      expect(warnSpy.mock.calls).toHaveLength(1);
      expect(String(warnSpy.mock.calls[0]?.[0])).toContain('Received malformed server message');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('reports a protocol error that names no result as a plain warning', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      scripted = scriptedServer((ws) =>
        ws.send(
          JSON.stringify({ type: 'protocolError', code: 'invalid_message', message: 'bad frame' }),
        ),
      );
      worker = createWorker(scripted);

      await worker.connect();
      await waitForCondition(() => warnSpy.mock.calls.length > 0, { label: 'warning logged' });

      expect(String(warnSpy.mock.calls[0]?.[0])).toBe(
        '[weft] RemoteWorker protocol error from server: bad frame',
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('says so when a rejected result is not in the outbox', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      scripted = scriptedServer((ws) =>
        ws.send(
          JSON.stringify({
            type: 'protocolError',
            code: 'invalid_message',
            message: 'unknown operation',
            operationId: 'op-never-buffered',
            attemptToken: 'attempt-1',
          }),
        ),
      );
      worker = createWorker(scripted);

      await worker.connect();
      await waitForCondition(() => warnSpy.mock.calls.length > 0, { label: 'warning logged' });

      expect(String(warnSpy.mock.calls[0]?.[0])).toContain(
        '; no matching buffered result was found',
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('rejects connect() when the socket cannot take every buffered result on registration', async () => {
    const gate = createDeferred();
    const taskFrame = (operationId: string) =>
      JSON.stringify({
        type: 'task',
        operationId,
        attemptToken: `attempt-${operationId}`,
        activityName: 'orders.wait',
        input: {},
      });
    scripted = scriptedServer((ws) => {
      if (
        scripted === undefined ||
        scripted.received.filter((m) => m['type'] === 'register').length > 1
      ) {
        return;
      }
      ws.send(taskFrame('op-1'));
      ws.send(taskFrame('op-2'));
      // Drop the connection once both tasks are in flight, so the results have nowhere to go.
      setTimeout(() => ws.close(), 20);
    });
    worker = createWorker(scripted, {}, { wait: async () => gate.promise });

    await worker.connect();
    await waitForCondition(() => !worker!.connected, { label: 'connection dropped' });
    gate.resolve();
    await waitForCondition(() => worker!.inFlight === 0, { label: 'both results buffered' });

    // The first buffered result closes the socket as it goes out, so the second finds it unusable.
    const realSend = WebSocket.prototype.send;
    const sendSpy = spyOn(WebSocket.prototype, 'send').mockImplementation(function (
      this: WebSocket,
      data: Parameters<WebSocket['send']>[0],
    ) {
      realSend.call(this, data);
      if (typeof data === 'string' && data.includes('"taskResult"')) this.close();
    });
    try {
      const failure = await rejectionOf(worker.connect());

      expect((failure as Error).message).toBe(
        'reconnect required: result flush failed during registration',
      );
    } finally {
      sendSpy.mockRestore();
    }
  });

  // Regression (COR-2295): a matching `cancel` control used to abort the attempt's controller and
  // leave its automatic heartbeat interval armed until the activity settled, so an activity that
  // ignores its signal kept heartbeating a canceled attempt. The spies prove the exact interval is
  // cleared at cancel time, without waiting out a real tick.
  it("clears a canceled attempt's automatic heartbeat while its activity ignores the signal", async () => {
    using setIntervalSpy = spyOn(globalThis, 'setInterval');
    using clearIntervalSpy = spyOn(globalThis, 'clearInterval');
    // Compared by identity: two timers are deep-equal, so `toHaveBeenCalledWith` cannot tell them apart.
    const clearedTimers = () => clearIntervalSpy.mock.calls.map((call) => call[0] as unknown);
    const release = createDeferred();
    const signals = new Map<string, AbortSignal>();
    // A 60-second lease derives a 20-second automatic heartbeat, a delay no other worker timer uses.
    const leaseMilliseconds = 60_000;
    const activityHeartbeatMilliseconds = 20_000;
    // Two attempts of ONE operation, as a lease-expiry redispatch leaves them: only the older one
    // is canceled, so the newer attempt's heartbeat proves the cancellation is fenced by token.
    const taskFrame = (attemptToken: string, activityName: string, visibilityTimeout?: number) =>
      JSON.stringify({
        type: 'task',
        operationId: attemptToken === 'attempt-barrier' ? 'op-barrier' : 'op-shared',
        attemptToken,
        activityName,
        input: attemptToken,
        ...(visibilityTimeout === undefined ? {} : { visibilityTimeout }),
      });
    const cancelFrame = (attemptToken: string, reason: string) =>
      JSON.stringify({ type: 'cancel', operationId: 'op-shared', attemptToken, reason });
    const server = scriptedServer((ws) => {
      // Frames on one connection are handled in send order, and each task registers its attempt
      // and arms its heartbeat before its first await, so the barrier's result proves every
      // cancellation before it already ran.
      ws.send(taskFrame('attempt-old', 'orders.stubborn', leaseMilliseconds));
      ws.send(taskFrame('attempt-new', 'orders.stubborn', leaseMilliseconds));
      ws.send(cancelFrame('attempt-stale', 'stale'));
      ws.send(cancelFrame('attempt-old', 'operator stop'));
      ws.send(cancelFrame('attempt-old', 'repeated'));
      ws.send(taskFrame('attempt-barrier', 'orders.echo'));
    });
    scripted = server;
    const taskResults = () => server.received.filter((message) => message['type'] === 'taskResult');
    const resultFor = (attemptToken: string) =>
      taskResults().find((message) => message['attemptToken'] === attemptToken);
    worker = createWorker(
      server,
      {},
      {
        echo: async (input) => input,
        // Non-cooperative: never looks at its signal, and settles only when the test releases it.
        stubborn: async (input, context) => {
          if (context !== undefined) signals.set(String(input), context.signal);
          await release.promise;
          throw new Error('settled late');
        },
      },
    );

    await worker.connect();
    await waitForCondition(() => signals.size === 2 && resultFor('attempt-barrier') !== undefined, {
      label: 'barrier result after the cancellations',
    });

    const intervalCalls = setIntervalSpy.mock.calls as unknown as Array<readonly unknown[]>;
    const heartbeatTimers = intervalCalls.flatMap((call, index) =>
      call[1] === activityHeartbeatMilliseconds
        ? [(setIntervalSpy.mock.results[index] as { value: unknown } | undefined)?.value]
        : [],
    );
    expect(heartbeatTimers).toHaveLength(2);
    const [canceledTimer, liveTimer] = heartbeatTimers;
    expect(signals.get('attempt-old')?.reason).toBe('operator stop');
    expect(signals.get('attempt-new')?.aborted).toBe(false);
    expect(clearedTimers()).toContain(canceledTimer);
    expect(clearedTimers()).not.toContain(liveTimer);
    // Both stubborn attempts are still unsettled; only the barrier finished.
    expect(worker.inFlight).toBe(2);

    release.resolve();
    await waitForCondition(
      () => resultFor('attempt-old') !== undefined && resultFor('attempt-new') !== undefined,
      { label: 'late settlements received' },
    );

    expect(resultFor('attempt-old')).toMatchObject({ status: 'cancelled', error: 'operator stop' });
    expect(resultFor('attempt-new')).toMatchObject({ status: 'failed', error: 'settled late' });
    expect(clearedTimers()).toContain(liveTimer);
    expect(
      server.received.filter(
        (message) =>
          message['type'] === 'activityHeartbeat' && message['attemptToken'] === 'attempt-old',
      ),
    ).toEqual([]);
  });
});

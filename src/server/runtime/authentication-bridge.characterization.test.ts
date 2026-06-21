import { describe, expect, it, spyOn } from 'bun:test';

import { createServerWebSocketHandlers } from './authentication-bridge.ts';
import { minimalServeOptions, minimalServerContext } from './server-context.test-support.ts';

import type { WebSocketData } from '../json-rpc-websocket-runtime.ts';

type FakeWorkerSocket = {
  data: WebSocketData;
};

function createWorkerSocket(workerId: string): FakeWorkerSocket {
  return {
    data: {
      connectionType: 'worker',
      pathname: '/v1/tasks/default/stream',
      queue: 'default',
      workerId,
    },
  };
}

describe('createServerWebSocketHandlers', () => {
  it('ignores stale worker close events after the worker already reconnected', () => {
    const context = minimalServerContext();
    const handlers = createServerWebSocketHandlers(context, minimalServeOptions(), () => {});
    const staleSocket = createWorkerSocket('worker-1');
    const freshSocket = createWorkerSocket('worker-1');
    context.workerSockets.set('worker-1', freshSocket as never);

    using warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    handlers.close(staleSocket as never);

    expect(warnSpy).toHaveBeenCalledWith(
      '[weft] Ignoring stale socket close for worker "worker-1" — already reconnected',
    );
    expect(context.workerSockets.get('worker-1') as unknown).toBe(freshSocket);
    expect(context.pendingWorkerRequeues.size).toBe(0);
  });
});

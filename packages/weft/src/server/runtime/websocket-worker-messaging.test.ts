import type { ServerWebSocket } from 'bun';
import { describe, expect, it } from 'bun:test';

import { waitForCondition } from "../../../test-support/embedded/testing/src/fake-timers.ts";
import type { WebSocketData } from '../json-rpc-websocket-runtime.ts';
import { closeWorkerSocket } from './websocket-worker-messaging.ts';

function createSocket(failures: { unsubscribe?: boolean; terminate?: boolean }) {
  const calls: string[] = [];
  const socket = {
    data: { pathname: '/v1/tasks/default/stream', connectionType: 'worker' },
    unsubscribe() {
      calls.push('unsubscribe');
      if (failures.unsubscribe) throw new Error('already detached');
    },
    close(code: number, reason: string) {
      calls.push(`close:${code}:${reason}`);
    },
    terminate() {
      calls.push('terminate');
      if (failures.terminate) throw new Error('already closed');
    },
  } as unknown as ServerWebSocket<WebSocketData>;
  return { socket, calls };
}

describe('closeWorkerSocket', () => {
  it('unsubscribes, closes with the given code and reason, then force-terminates', async () => {
    const { socket, calls } = createSocket({});

    closeWorkerSocket(socket, 4001, 'superseded');
    expect(calls).toEqual(['unsubscribe', 'close:4001:superseded']);

    await waitForCondition(() => calls.includes('terminate'), { label: 'socket terminated' });
  });

  it('still closes the socket when it was already detached from its subscription', () => {
    const { socket, calls } = createSocket({ unsubscribe: true });

    expect(() => closeWorkerSocket(socket, 1000, 'bye')).not.toThrow();
    expect(calls).toEqual(['unsubscribe', 'close:1000:bye']);
  });

  it('tolerates a peer that completed the close handshake before the forced termination', async () => {
    const { socket, calls } = createSocket({ terminate: true });

    closeWorkerSocket(socket, 1000, 'bye');
    await waitForCondition(() => calls.includes('terminate'), { label: 'termination attempted' });

    expect(calls).toEqual(['unsubscribe', 'close:1000:bye', 'terminate']);
  });
});

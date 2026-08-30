import { describe, expect, it, mock } from 'bun:test';

import { WorkerListenerRegistry } from './worker-listener-registry.ts';

describe('WorkerListenerRegistry', () => {
  it('forwards message payloads and detaches only when idle', () => {
    const registry = new WorkerListenerRegistry();
    const messageHandler = mock(() => {});
    const errorHandler = mock(() => {});
    const messageErrorHandler = mock(() => {});
    const listeners = new Map<string, EventListener>();
    const worker = {
      addEventListener: mock((type: string, listener: EventListener) => {
        listeners.set(type, listener);
      }),
      removeEventListener: mock((type: string) => {
        listeners.delete(type);
      }),
    } as unknown as Worker;

    registry.attach(worker, {
      message: messageHandler,
      error: errorHandler,
      messageerror: messageErrorHandler,
    });

    listeners.get('message')?.(new MessageEvent('message', { data: { ok: true } }));
    expect(messageHandler).toHaveBeenCalledWith({ ok: true });

    registry.detachIfIdle(worker, () => false);
    expect(listeners.size).toBe(3);

    registry.detachIfIdle(worker, () => true);
    expect(listeners.size).toBe(0);
  });

  it('ignores duplicate attaches and detaches every worker on detachAll', () => {
    const registry = new WorkerListenerRegistry();
    const firstWorker = {
      addEventListener: mock(() => {}),
      removeEventListener: mock(() => {}),
    } as unknown as Worker;
    const secondWorker = {
      addEventListener: mock(() => {}),
      removeEventListener: mock(() => {}),
    } as unknown as Worker;
    const handlers = {
      message: (_message: unknown) => {},
      error: (_event: ErrorEvent) => {},
      messageerror: () => {},
    };

    registry.attach(firstWorker, handlers);
    registry.attach(firstWorker, handlers);
    registry.attach(secondWorker, handlers);
    registry.detachAll();

    expect(firstWorker.addEventListener).toHaveBeenCalledTimes(3);
    expect(secondWorker.removeEventListener).toHaveBeenCalledTimes(3);
  });
});

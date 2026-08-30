import { describe, expect, it, spyOn } from 'bun:test';

import { stopBunServerForShutdown } from './stop-server.ts';

describe('stopBunServerForShutdown', () => {
  it('logs rejected stop promises and still settles', async () => {
    const error = new Error('stop failed');
    const consoleError = spyOn(console, 'error').mockImplementation(() => {});
    const server = {
      stop() {
        return Promise.reject(error);
      },
    };

    await expect(stopBunServerForShutdown(server as never)).rejects.toThrow('stop failed');

    expect(consoleError).toHaveBeenCalledWith('[weft] Bun server stop failed:', error);
    consoleError.mockRestore();
  });

  it('clears the fallback timeout after a successful stop', async () => {
    const clearTimeoutSpy = spyOn(globalThis, 'clearTimeout');
    const server = {
      stop() {
        return Promise.resolve();
      },
    };

    await stopBunServerForShutdown(server as never);

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });
});

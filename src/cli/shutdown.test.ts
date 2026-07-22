import { describe, expect, it } from 'bun:test';

import {
  createCliShutdownHandler,
  type CliShutdownDependencies,
  type CliShutdownSignal,
} from './shutdown.ts';

function createDependencies(overrides: Partial<CliShutdownDependencies> = {}): {
  dependencies: CliShutdownDependencies;
  operations: string[];
} {
  const operations: string[] = [];
  return {
    operations,
    dependencies: {
      stopServer: async () => {
        operations.push('stop server');
      },
      removeRunLockfile: async () => {
        operations.push('remove run lockfile');
      },
      disposeStorage: () => {
        operations.push('dispose storage');
      },
      log: (message) => {
        operations.push(`log: ${message}`);
      },
      reportError: (message, error) => {
        operations.push(`error: ${message} ${String(error)}`);
      },
      exit: (code) => {
        operations.push(`exit: ${code}`);
      },
      ...overrides,
    },
  };
}

describe('createCliShutdownHandler', () => {
  for (const signal of ['SIGINT', 'SIGTERM'] satisfies CliShutdownSignal[]) {
    it(`runs the same ordered shutdown sequence for ${signal}`, async () => {
      const { dependencies, operations } = createDependencies();
      const shutdown = createCliShutdownHandler(dependencies);

      await shutdown(signal);

      expect(operations).toEqual([
        `log: \nReceived ${signal}; shutting down...`,
        'stop server',
        'remove run lockfile',
        'dispose storage',
        'exit: 0',
      ]);
    });
  }

  it('shares one in-flight shutdown across overlapping signals', async () => {
    const stop = Promise.withResolvers<void>();
    let stopCalls = 0;
    let lockfileCalls = 0;
    let disposalCalls = 0;
    let exitCalls = 0;
    const notices: string[] = [];
    const { dependencies } = createDependencies({
      stopServer: () => {
        stopCalls += 1;
        return stop.promise;
      },
      removeRunLockfile: async () => {
        lockfileCalls += 1;
      },
      disposeStorage: () => {
        disposalCalls += 1;
      },
      log: (message) => notices.push(message),
      exit: () => {
        exitCalls += 1;
      },
    });
    const shutdown = createCliShutdownHandler(dependencies);

    const firstShutdown = shutdown('SIGTERM');
    const overlappingShutdown = shutdown('SIGINT');

    expect(overlappingShutdown).toBe(firstShutdown);
    expect(stopCalls).toBe(1);
    expect(notices).toEqual(['\nReceived SIGTERM; shutting down...']);

    stop.resolve();
    await Promise.all([firstShutdown, overlappingShutdown]);

    expect(lockfileCalls).toBe(1);
    expect(disposalCalls).toBe(1);
    expect(exitCalls).toBe(1);
  });

  it('reports lockfile cleanup errors and continues successful shutdown', async () => {
    const lockfileError = new Error('lockfile unavailable');
    const { dependencies, operations } = createDependencies({
      removeRunLockfile: async () => {
        throw lockfileError;
      },
    });
    const shutdown = createCliShutdownHandler(dependencies);

    await shutdown('SIGTERM');

    expect(operations).toEqual([
      'log: \nReceived SIGTERM; shutting down...',
      'stop server',
      'error: [weft] Failed to remove run lockfile: Error: lockfile unavailable',
      'dispose storage',
      'exit: 0',
    ]);
  });

  it('reports server stop errors and exits unsuccessfully without later cleanup', async () => {
    const { dependencies, operations } = createDependencies({
      stopServer: async () => {
        operations.push('stop server');
        throw new Error('stop failed');
      },
    });
    const shutdown = createCliShutdownHandler(dependencies);

    await shutdown('SIGINT');

    expect(operations).toEqual([
      'log: \nReceived SIGINT; shutting down...',
      'stop server',
      'error: [weft] Shutdown error: Error: stop failed',
      'exit: 1',
    ]);
  });

  it('reports storage disposal errors and exits unsuccessfully', async () => {
    const { dependencies, operations } = createDependencies({
      disposeStorage: () => {
        operations.push('dispose storage');
        throw new Error('disposal failed');
      },
    });
    const shutdown = createCliShutdownHandler(dependencies);

    await shutdown('SIGTERM');

    expect(operations).toEqual([
      'log: \nReceived SIGTERM; shutting down...',
      'stop server',
      'remove run lockfile',
      'dispose storage',
      'error: [weft] Shutdown error: Error: disposal failed',
      'exit: 1',
    ]);
  });
});

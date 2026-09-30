export const CLI_SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

export type CliShutdownSignal = (typeof CLI_SHUTDOWN_SIGNALS)[number];

export type CliShutdownDependencies = {
  readonly stopServer: () => Promise<void>;
  readonly removeRunLockfile: () => Promise<void>;
  readonly disposeStorage: () => void;
  readonly log: (message: string) => void;
  readonly reportError: (message: string, error: unknown) => void;
  readonly exit: (code: 0 | 1) => void;
};

async function runCliShutdown(
  signal: CliShutdownSignal,
  dependencies: CliShutdownDependencies,
): Promise<void> {
  dependencies.log(`\nReceived ${signal}; shutting down...`);

  let failed = false;
  const attempt = async (message: string, step: () => void | Promise<void>): Promise<void> => {
    try {
      await step();
    } catch (error) {
      failed = true;
      dependencies.reportError(message, error);
    }
  };

  await attempt('[weft] Failed to stop server:', dependencies.stopServer);
  await attempt('[weft] Failed to remove run lockfile:', dependencies.removeRunLockfile);
  await attempt('[weft] Failed to dispose storage:', dependencies.disposeStorage);
  dependencies.exit(failed ? 1 : 0);
}

export function createCliShutdownHandler(
  dependencies: CliShutdownDependencies,
): (signal: CliShutdownSignal) => Promise<void> {
  let shutdownPromise: Promise<void> | undefined;

  return (signal) => {
    shutdownPromise ??= runCliShutdown(signal, dependencies);
    return shutdownPromise;
  };
}

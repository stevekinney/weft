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

  try {
    await dependencies.stopServer();
    try {
      await dependencies.removeRunLockfile();
    } catch (error) {
      dependencies.reportError('[weft] Failed to remove run lockfile:', error);
    }
    dependencies.disposeStorage();
    dependencies.exit(0);
  } catch (error) {
    dependencies.reportError('[weft] Shutdown error:', error);
    dependencies.exit(1);
  }
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

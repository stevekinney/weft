/**
 * A real child process that throws synchronously while loading, exiting
 * immediately with a non-zero status. Used to exercise {@link
 * import('../child-process-realm.ts').ChildProcessRealm}'s real
 * `onExit`/`onDisconnect` handling (`#handleProcessDown`) with an actual
 * spawned process rather than a mock. The `Bun.spawn` IPC counterpart of
 * `revision-realm-throwing-worker.ts`.
 */
throw new Error('revision-realm-child-process-throwing: deliberate load-time failure');

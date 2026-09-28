/**
 * A real child process that never sends anything back to its host — not
 * even a `ready` message — used to exercise {@link
 * import('../child-process-realm.ts').ChildProcessRealm.waitUntilReady}'s
 * timeout path with a real spawned process rather than a mock. The `Bun.spawn`
 * IPC counterpart of `revision-realm-unresponsive-worker.ts`.
 */
process.on('message', () => {
  // Deliberately silent: never respond to `realm-configure` or anything else.
});

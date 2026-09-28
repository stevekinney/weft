/// <reference lib="webworker" />
/**
 * A real Worker that never sends anything back to its host — not even a
 * `ready` message — used to exercise {@link
 * import('../worker-realm.ts').WorkerRealm.waitUntilReady}'s timeout path
 * with a real Worker rather than a mock.
 */
self.onmessage = () => {
  // Deliberately silent: never respond to `realm-configure` or anything else.
};

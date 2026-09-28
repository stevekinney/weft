/// <reference lib="webworker" />
/**
 * A real Worker that throws synchronously while loading, used to exercise
 * {@link import('../worker-realm.ts').WorkerRealm}'s real `error` event
 * handling (`#handleWorkerFailure`) with an actual Worker rather than a
 * mock.
 */
throw new Error('revision-realm-throwing-worker: deliberate load-time failure');

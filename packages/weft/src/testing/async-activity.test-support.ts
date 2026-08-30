/**
 * Shared test helpers for out-of-band ("async") activity completion.
 *
 * Several suites need the same two things: a way to capture the durable task
 * token the engine mints when an activity defers, and a common payload-size cap
 * for the cross-transport contract. Centralizing them here keeps the helper
 * byte-identical across the engine, server-operation, and client suites.
 *
 * Test-only: imports `bun:test`-adjacent engine internals and must never be
 * pulled into the build (the `.test-support.ts` suffix excludes it).
 */

import type { Engine } from '../core/engine.ts';

/**
 * A generous payload cap (1 MiB) for contract-test engines. Large enough that
 * every existing small-payload contract test is unaffected, while giving the
 * payload-size contract test a known limit to exceed.
 */
export const CONTRACT_PAYLOAD_CAP_BYTES = 1_048_576;

/** Resolve with the task token the next time `engine` parks an async activity. */
export function nextAsyncPendingToken(engine: Engine): Promise<string> {
  return new Promise<string>((resolve) => {
    engine.addEventListener('activity:async-pending', (event) => resolve(event.token), {
      once: true,
    });
  });
}

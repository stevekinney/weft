/**
 * Internal sentinel: the idempotent create batch lost its compare-and-swap to a
 * concurrent caller holding the same idempotency key. Never surfaced to users —
 * `start` / `startOrSignal` catch it and resolve to the winning run's handle.
 *
 * Lives in its own module so both `start-commit.ts` and the attribution helper it
 * delegates to (`start-precondition-attribution.ts`) can raise it without an import
 * cycle between them.
 */
export class StartIdempotencyRaceLostError extends Error {
  constructor() {
    super('start idempotency compare-and-swap lost to a concurrent caller');
    this.name = 'StartIdempotencyRaceLostError';
  }
}

/**
 * Test-only `Storage.conditionalBatch` interception for
 * `workflow-claim-registry.test.ts`. Wraps a base storage (typically
 * `MemoryStorage`) and lets a test queue one directive per upcoming
 * `conditionalBatch` call — force it to lose the race, throw a storage error,
 * run a side effect immediately before delegating (to simulate a competitor
 * racing in between a registry method's reads and its write), or pause until
 * the test explicitly releases it (to force deterministic interleaving of two
 * registry calls). Calls beyond the queued directives pass straight through
 * to the base storage. Mirrors the shape of `lease.test-support.ts`'s gated
 * storage, generalized to more than one directive kind.
 */

import type {
  BatchOperation,
  ConditionalBatchCondition,
  Storage,
} from '../../storage/interface.ts';

type ConditionalBatchDirective =
  | { kind: 'force-false' }
  | { kind: 'throw'; error: Error }
  | { kind: 'before'; run: () => void | Promise<void> }
  | { kind: 'gate'; wait: Promise<void>; signalReached: () => void };

export type WorkflowClaimTestStorage = {
  readonly storage: Storage;
  /** Next `conditionalBatch` call returns `false` without touching base storage. */
  queueForceFalse(): void;
  /** Next `conditionalBatch` call throws `error` without touching base storage. */
  queueThrow(error: Error): void;
  /** Next `conditionalBatch` call runs `run` first, then delegates normally (a real CAS against the mutated state). */
  queueBeforeCommit(run: () => void | Promise<void>): void;
  /** Next `conditionalBatch` call pauses before delegating; `reached` resolves once paused, `release` resumes it. */
  queueGate(): { reached: Promise<void>; release: () => void };
};

export function createWorkflowClaimTestStorage(baseStorage: Storage): WorkflowClaimTestStorage {
  const queue: ConditionalBatchDirective[] = [];

  async function conditionalBatch(
    conditions: ConditionalBatchCondition[],
    operations: BatchOperation[],
  ): Promise<boolean> {
    const directive = queue.shift();
    if (directive?.kind === 'force-false') return false;
    if (directive?.kind === 'throw') throw directive.error;
    if (directive?.kind === 'before') await directive.run();
    if (directive?.kind === 'gate') {
      directive.signalReached();
      await directive.wait;
    }
    if (baseStorage.conditionalBatch === undefined) {
      throw new Error('workflow-claim test storage requires conditionalBatch support.');
    }
    return baseStorage.conditionalBatch(conditions, operations);
  }

  return {
    storage: {
      capabilities: () => baseStorage.capabilities(),
      get: (key) => baseStorage.get(key),
      put: (key, value) => baseStorage.put(key, value),
      delete: (key) => baseStorage.delete(key),
      scan: (prefix, options) => baseStorage.scan(prefix, options),
      batch: (operations) => baseStorage.batch(operations),
      conditionalBatch,
      [Symbol.dispose]: () => baseStorage[Symbol.dispose](),
    },
    queueForceFalse: () => queue.push({ kind: 'force-false' }),
    queueThrow: (error) => queue.push({ kind: 'throw', error }),
    queueBeforeCommit: (run) => queue.push({ kind: 'before', run }),
    queueGate: () => {
      let release!: () => void;
      let signalReached!: () => void;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reached = new Promise<void>((resolve) => {
        signalReached = resolve;
      });
      queue.push({ kind: 'gate', wait, signalReached });
      return { reached, release };
    },
  };
}

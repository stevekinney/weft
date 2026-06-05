import { describe, expect, it } from 'bun:test';

import { NeonStorage, type NeonPool, type NeonPoolClient } from './neon.ts';
import { bytes as encode } from './storage-adapter.test-support.ts';

/**
 * A {@link NeonPool} stub that injects a Postgres serialization failure
 * (`SQLSTATE 40001`) at `COMMIT` for a configurable number of attempts. PGlite
 * serializes on one connection and never produces a 40001, so the SERIALIZABLE
 * retry loop — the entire reason the Pool driver was chosen — can only be
 * exercised deterministically with a stub like this. The stub records how many
 * times each condition key is read so a test can prove the loop re-runs the
 * whole `BEGIN → read → compare → write → COMMIT` cycle on every retry.
 */
class FaultInjectingPool implements NeonPool {
  /** Number of COMMITs that should fail with 40001 before one succeeds. */
  #commitFailuresRemaining: number;
  /** Count of SELECTs issued per key, across all attempts. */
  readonly selectCounts = new Map<string, number>();
  /** Total number of BEGIN statements seen (one per transaction attempt). */
  beginCount = 0;
  /** Whether end() was called. */
  ended = false;

  constructor(commitFailures: number) {
    this.#commitFailuresRemaining = commitFailures;
  }

  async query(): Promise<{ rows: Array<Record<string, unknown>> }> {
    // Single-statement hot paths (ensureTable) — return nothing meaningful.
    return { rows: [] };
  }

  async connect(): Promise<NeonPoolClient> {
    return {
      query: async (sql: string, parameters?: unknown[]) => {
        if (sql.startsWith('BEGIN')) {
          this.beginCount += 1;
          return { rows: [] };
        }
        if (sql === 'COMMIT') {
          if (this.#commitFailuresRemaining > 0) {
            this.#commitFailuresRemaining -= 1;
            const error = Object.assign(new Error('could not serialize access'), {
              code: '40001',
            });
            throw error;
          }
          return { rows: [] };
        }
        if (sql === 'ROLLBACK') {
          return { rows: [] };
        }
        if (sql.startsWith('SELECT value')) {
          const key = String(parameters?.[0]);
          this.selectCounts.set(key, (this.selectCounts.get(key) ?? 0) + 1);
          // Report the key as absent so the null precondition holds.
          return { rows: [] };
        }
        // INSERT/UPSERT/DELETE within the transaction — succeed silently.
        return { rows: [] };
      },
      release: () => {
        // No pool to return to.
      },
    };
  }

  async end(): Promise<void> {
    this.ended = true;
  }
}

describe('NeonStorage conditionalBatch serialization retry', () => {
  it('retries the whole transaction on 40001 and succeeds, re-reading conditions each attempt', async () => {
    const pool = new FaultInjectingPool(2);
    await using storage = new NeonStorage({ url: 'stub://', pool });

    const applied = await storage.conditionalBatch(
      [{ key: 'idem:k', expectedValue: null }],
      [{ type: 'put', key: 'idem:k', value: encode('v') }],
    );

    expect(applied).toBe(true);
    // Two failed COMMITs + one success = three transaction attempts.
    expect(pool.beginCount).toBe(3);
    // The condition must be re-read on every attempt, proving the loop restarts
    // the full BEGIN → read → compare → write → COMMIT cycle rather than retrying
    // only the COMMIT against stale reads.
    expect(pool.selectCounts.get('idem:k')).toBe(3);
  });

  it('throws after exhausting the retry cap instead of silently returning false', async () => {
    // Five failures with a cap of five means every attempt's COMMIT fails. The
    // call must throw — a silent false is indistinguishable from a precondition
    // mismatch and would corrupt compare-and-swap callers.
    const pool = new FaultInjectingPool(5);
    await using storage = new NeonStorage({ url: 'stub://', pool });

    await expect(
      storage.conditionalBatch(
        [{ key: 'idem:k', expectedValue: null }],
        [{ type: 'put', key: 'idem:k', value: encode('v') }],
      ),
    ).rejects.toThrow('exhausted 5 serialization retries');

    expect(pool.beginCount).toBe(5);
  });
});

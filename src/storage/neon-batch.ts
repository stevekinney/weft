import {
  storageValuesEqual,
  type BatchOperation,
  type ConditionalBatchCondition,
} from './interface.ts';
import {
  resolveBatchNetEffect,
  toBytea,
  toStorageValue,
  type BatchNetEffect,
} from './neon-value-mapping.ts';
import type { NeonPoolClient } from './neon.ts';
import type { PostgresKeyValueQueries } from './postgres-key-value-queries.ts';

/**
 * The collapsed transaction-phase helpers for {@link NeonStorage}'s `batch()` and
 * `conditionalBatch()`. Each phase runs as ONE statement regardless of operation
 * count, so a checkpoint commit no longer pays one WebSocket round trip per key.
 * Split out of `neon.ts` to keep that module under the size ceiling; all run on a
 * caller-supplied pinned-transaction `client`.
 *
 * @module storage/neon-batch
 */

/**
 * Evaluate every precondition with ONE `key = ANY($1)` read instead of one
 * `SELECT` per condition. Builds a key→value map from the single result, then
 * compares each condition's `expectedValue` against the current value (absent
 * key → `null`, which matches an expect-absent condition). Returns `true` only
 * when every condition holds. With no conditions, holds vacuously and issues no
 * query.
 */
export async function conditionsHold(
  client: NeonPoolClient,
  queries: PostgresKeyValueQueries,
  conditions: ConditionalBatchCondition[],
): Promise<boolean> {
  if (conditions.length === 0) return true;

  const keys = conditions.map((condition) => condition.key);
  const result = await client.query(queries.selectValuesByKeys, [keys]);
  const currentByKey = new Map<string, Uint8Array>();
  for (const row of result.rows) {
    const raw = row['value'];
    if (raw !== null && raw !== undefined) {
      currentByKey.set(row['key'] as string, toStorageValue(raw));
    }
  }

  for (const condition of conditions) {
    const currentValue = currentByKey.get(condition.key) ?? null;
    if (!storageValuesEqual(currentValue, condition.expectedValue)) {
      return false;
    }
  }
  return true;
}

/** Resolve a batch to its net effect and apply it as collapsed statements. */
export async function applyBatchNetEffect(
  client: NeonPoolClient,
  queries: PostgresKeyValueQueries,
  operations: BatchOperation[],
): Promise<void> {
  await writeBatchNetEffect(client, queries, resolveBatchNetEffect(operations));
}

/**
 * Write a resolved batch net effect with at most one upsert and one delete
 * statement — the put-set as a single `unnest`-driven multi-row upsert, the
 * delete-set as a single `key = ANY($1)` delete. The two key sets are disjoint
 * (see {@link resolveBatchNetEffect}), so the statements commute; each is
 * skipped when its set is empty.
 */
export async function writeBatchNetEffect(
  client: NeonPoolClient,
  queries: PostgresKeyValueQueries,
  netEffect: BatchNetEffect,
): Promise<void> {
  if (netEffect.puts.size > 0) {
    const keys: string[] = [];
    const values: Buffer[] = [];
    for (const [key, value] of netEffect.puts) {
      keys.push(key);
      values.push(toBytea(value));
    }
    await client.query(queries.upsertValuesByKeys, [keys, values]);
  }
  if (netEffect.deletes.size > 0) {
    await client.query(queries.deleteValuesByKeys, [[...netEffect.deletes]]);
  }
}

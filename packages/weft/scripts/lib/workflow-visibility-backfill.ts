/**
 * Library half of `scripts/rebuild-workflow-visibility-indexes.ts`. Lives
 * here so it can be exercised by unit tests against `MemoryStorage`
 * without spawning the CLI executable entrypoint.
 *
 * @module scripts/lib/workflow-visibility-backfill
 */

import { decode, encode } from '../../src/core/codec.ts';
import { decodeWorkflowState } from '../../src/core/engine/validation.ts';
import {
  WORKFLOW_VISIBILITY_INDEX_VERSION,
  WORKFLOW_VISIBILITY_WATERMARK_CACHE_TTL_MS,
  buildWorkflowVisibilityIndexTransition,
} from '../../src/core/engine/workflow-indexes.ts';
import {
  KEYS,
  storageConditionalBatch,
  tryDecodeStorageKeyComponent,
  type BatchOperation,
  type ConditionalBatchCondition,
  type Storage,
} from '../../src/storage/interface.ts';

// Per-workflow manifest rows, written only by index layout version 1.
const LAYOUT_VERSION_ONE_MANIFEST_PREFIX = 'wf-idx-manifest:';

const VISIBILITY_INDEX_PREFIXES = [
  'wf-idx-status:',
  'wf-idx-type:',
  'wf-idx-tenant:',
  'wf-idx-created:',
  'wf-idx-updated:',
  'wf-idx-deadline:',
  LAYOUT_VERSION_ONE_MANIFEST_PREFIX,
];

/**
 * How long a run waits after removing the `wf-idx-meta:version` watermark before
 * it touches any index row. Engines cache the watermark for up to
 * {@link WORKFLOW_VISIBILITY_WATERMARK_CACHE_TTL_MS}, so twice that window
 * covers the cache age plus the read itself, after which no `list()` or
 * `aggregate()` still trusts rows the run is about to clear.
 */
export const WORKFLOW_VISIBILITY_BACKFILL_SETTLE_MILLISECONDS =
  2 * WORKFLOW_VISIBILITY_WATERMARK_CACHE_TTL_MS;

/** Thrown when another backfill run holds `wf-idx-meta:building`. */
export class WorkflowVisibilityBackfillInProgressError extends Error {
  constructor() {
    super(
      'Another workflow visibility backfill holds wf-idx-meta:building. Wait for it to finish; if it crashed, run --drop and start again.',
    );
    this.name = 'WorkflowVisibilityBackfillInProgressError';
  }
}

export type BackfillReport = {
  processed: number;
  conflicts: number;
  watermarkWritten: boolean;
};

export type DropReport = {
  rowsDeleted: number;
};

/**
 * Test-friendly logger: receives every progress message the CLI would
 * print. Default is a no-op so unit tests stay quiet.
 */
export type BackfillLogger = (message: string) => void;

export type WorkflowVisibilityBackfillOptions = {
  logger?: BackfillLogger;
  checkpointEvery?: number;
  onWatermarkWritten?: () => void;
  /**
   * Milliseconds to wait, after removing the watermark, for running engines to
   * stop trusting the index. Defaults to
   * {@link WORKFLOW_VISIBILITY_BACKFILL_SETTLE_MILLISECONDS}; pass `0` only
   * when no engine can be running against the storage.
   */
  settleMilliseconds?: number;
};

async function settle(milliseconds: number, logger: BackfillLogger, reason: string): Promise<void> {
  if (milliseconds <= 0) return;
  logger(`Waiting ${milliseconds}ms for running engines to ${reason}.`);
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function isTopLevelWorkflowKey(key: string): boolean {
  const idPart = key.slice(3);
  return key.startsWith('wf:') && !idPart.includes(':');
}

async function loadCursor(storage: Storage): Promise<string | undefined> {
  const bytes = await storage.get(KEYS.workflowVisibilityMetaCursor());
  if (!bytes) return undefined;
  try {
    const decoded = decode(bytes);
    return typeof decoded === 'string' ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the workflow visibility indexes for every workflow in `storage`.
 * Refuses to run when the backend does not expose `conditionalBatch` so
 * a racing runtime write cannot leave a workflow below the cursor
 * un-indexed.
 *
 * Returns a {@link BackfillReport}. `watermarkWritten` is `true` only
 * when the full scan completed with no conditional-batch conflicts —
 * any conflicts indicate the engine wrote to a workflow during the
 * pass, in which case the caller should re-run the backfill. Throws
 * {@link WorkflowVisibilityBackfillInProgressError} when another run holds
 * the backfill lock, or when a `--drop` cleared this run's lock before it
 * published the watermark.
 */
export async function runWorkflowVisibilityBackfill(
  storage: Storage,
  options: WorkflowVisibilityBackfillOptions = {},
): Promise<BackfillReport> {
  const logger = options.logger ?? (() => undefined);
  const checkpointEvery = options.checkpointEvery ?? 500;

  if (storage.conditionalBatch === undefined) {
    throw new Error(
      'Storage backend does not expose conditionalBatch(); backfill requires it to avoid racing the engine.',
    );
  }

  // Claim the run. Two runs sweeping and rebuilding at once could let one
  // publish the watermark while the other is still deleting rows, so only the
  // run that wrote its own token into an absent key proceeds. The key is
  // released on every return or throw; a run killed outright leaves it, and
  // `--drop` clears it.
  const lockToken = encode(crypto.randomUUID());
  const claimed = await storageConditionalBatch(
    storage,
    [{ key: KEYS.workflowVisibilityMetaBuilding(), expectedValue: null }],
    [{ type: 'put', key: KEYS.workflowVisibilityMetaBuilding(), value: lockToken }],
  );
  if (!claimed) {
    throw new WorkflowVisibilityBackfillInProgressError();
  }

  try {
    return await backfillWhileHoldingLock(storage, options, logger, checkpointEvery, lockToken);
  } finally {
    await releaseBackfillLock(storage, lockToken);
  }
}

async function backfillWhileHoldingLock(
  storage: Storage,
  options: WorkflowVisibilityBackfillOptions,
  logger: BackfillLogger,
  checkpointEvery: number,
  lockToken: Uint8Array,
): Promise<BackfillReport> {
  // Readers stop trusting the index before any row changes. Engines that keep
  // writing during the run must have been created with
  // `maintainWorkflowVisibilityIndexes: true` (or `ownership: 'workflow-lease'`),
  // so every workflow that changes after the scan passed it is indexed by the
  // write that changed it. A run with no saved cursor rebuilds from empty,
  // because engines that skipped index writes while the watermark was stale may
  // have left stale or orphaned rows; a resumed run keeps its own rows.
  // A cursor saved by a layout-version-1 run sits over version-1 rows a
  // resumed run would keep, so the presence of a version-1 manifest row
  // discards the cursor and rebuilds from empty instead.
  const savedCursor = await loadCursor(storage);
  const resumeCursor =
    savedCursor !== undefined && (await hasLayoutVersionOneRows(storage)) ? undefined : savedCursor;
  await commitUnderLock(storage, lockToken, [
    ...WATERMARK_REMOVAL,
    ...(resumeCursor === savedCursor
      ? []
      : [{ type: 'delete' as const, key: KEYS.workflowVisibilityMetaCursor() }]),
  ]);
  await settle(
    options.settleMilliseconds ?? WORKFLOW_VISIBILITY_BACKFILL_SETTLE_MILLISECONDS,
    logger,
    'stop trusting the visibility index',
  );
  if (resumeCursor === undefined) {
    const cleared = await sweepVisibilityIndexRows(storage, logger, 500, lockToken);
    logger(`Cleared ${cleared} pre-existing index rows before the rebuild.`);
  }

  const { processed, conflicts } = await backfillWorkflowRows(
    storage,
    logger,
    checkpointEvery,
    lockToken,
  );

  if (conflicts > 0) {
    logger(
      `Backfill saw ${conflicts} conditional-batch conflicts. Re-run to process those workflows.`,
    );
    return { processed, conflicts, watermarkWritten: false };
  }

  // Advance the watermark and clear the cursor atomically, and only while this
  // run still holds the lock, so a `--drop` that took it over mid-run is not
  // overwritten by a watermark for rows it has since swept.
  await commitUnderLock(storage, lockToken, [
    {
      type: 'put',
      key: KEYS.workflowVisibilityMetaVersion(),
      value: encode(WORKFLOW_VISIBILITY_INDEX_VERSION),
    },
    {
      type: 'put',
      key: KEYS.workflowVisibilityMetaBuiltAt(),
      value: encode(Date.now()),
    },
    { type: 'delete', key: KEYS.workflowVisibilityMetaCursor() },
  ]);
  options.onWatermarkWritten?.();

  return { processed, conflicts: 0, watermarkWritten: true };
}

async function backfillWorkflowRows(
  storage: Storage,
  logger: BackfillLogger,
  checkpointEvery: number,
  lockToken: Uint8Array,
): Promise<{ processed: number; conflicts: number }> {
  const startCursor = await loadCursor(storage);
  if (startCursor !== undefined) {
    logger(`Resuming backfill from cursor ${startCursor}`);
  }

  let processed = 0;
  let conflicts = 0;
  const scanOptions = startCursor !== undefined ? { gt: startCursor } : undefined;

  for await (const [key, value] of storage.scan('wf:', scanOptions)) {
    const result = await indexWorkflow(storage, key, value, conflicts === 0, lockToken);
    if (result === 'skipped') continue;
    if (result === 'conflict') {
      conflicts += 1;
      logger(
        `Conflict on workflow ${tryDecodeStorageKeyComponent(key.slice(3))}; will retry on next pass.`,
      );
      continue;
    }

    processed += 1;
    if (processed % checkpointEvery === 0) {
      logger(
        `Processed ${processed} workflows (last: ${tryDecodeStorageKeyComponent(key.slice(3))})`,
      );
    }
  }

  return { processed, conflicts };
}

/** Keep the resume cursor behind the first conflict so a later pass retries that workflow. */
async function indexWorkflow(
  storage: Storage,
  key: string,
  value: Uint8Array,
  advanceCursor: boolean,
  lockToken: Uint8Array,
): Promise<'skipped' | 'committed' | 'conflict'> {
  if (!isTopLevelWorkflowKey(key)) return 'skipped';
  const workflowId = tryDecodeStorageKeyComponent(key.slice(3));
  if (workflowId === null) return 'skipped';

  // Put every key the state derives: index rows are a deterministic function
  // of state, so the rebuild comes from the state alone.
  const operations: BatchOperation[] = buildWorkflowVisibilityIndexTransition(
    null,
    decodeWorkflowState(value),
  );
  if (advanceCursor) {
    operations.push({
      type: 'put',
      key: KEYS.workflowVisibilityMetaCursor(),
      value: encode(key),
    });
  }
  return commitUnderLock(storage, lockToken, operations, [{ key, expectedValue: value }]);
}

/**
 * Delete every visibility-index row (not the meta keys) and return how many
 * were removed, reading and deleting one page of `batchSize` keys at a time. Each batch of deletes commits only while `lockToken` still
 * holds the lock, so a run that was taken over stops deleting; a single
 * `deletePrefix` cannot be fenced that way, so it is used only on a backend
 * without `conditionalBatch`, where nothing can be fenced.
 */
async function sweepVisibilityIndexRows(
  storage: Storage,
  logger: BackfillLogger,
  batchSize: number,
  lockToken: Uint8Array,
): Promise<number> {
  let rowsDeleted = 0;
  for (const prefix of VISIBILITY_INDEX_PREFIXES) {
    if (!storage.capabilities().conditionalBatch && storage.deletePrefix !== undefined) {
      const removed = await storage.deletePrefix(prefix);
      rowsDeleted += removed;
      logger(`Dropped prefix ${prefix} (${removed} rows)`);
      continue;
    }
    // One page at a time, so memory stays bounded by the batch size however large the index is.
    let after: string | undefined;
    for (;;) {
      const page: string[] = [];
      for await (const [key] of storage.scan(prefix, {
        limit: batchSize,
        ...(after === undefined ? {} : { gt: after }),
      })) {
        page.push(key);
      }
      if (page.length === 0) break;
      await commitUnderLock(
        storage,
        lockToken,
        page.map((key) => ({ type: 'delete' as const, key })),
      );
      rowsDeleted += page.length;
      after = page.at(-1);
    }
  }
  return rowsDeleted;
}

async function hasLayoutVersionOneRows(storage: Storage): Promise<boolean> {
  const manifestRows = storage.scan(LAYOUT_VERSION_ONE_MANIFEST_PREFIX, { limit: 1 });
  const rows = manifestRows[Symbol.asyncIterator]();
  const first = await rows.next();
  await rows.return?.();
  return first.done !== true;
}

const WATERMARK_REMOVAL: BatchOperation[] = [
  { type: 'delete', key: KEYS.workflowVisibilityMetaVersion() },
  { type: 'delete', key: KEYS.workflowVisibilityMetaBuiltAt() },
];

/**
 * Commit `operations` only while `lockToken` still holds the backfill lock, plus any extra
 * `conditions`. Every write a backfill or drop makes goes through here, so a run whose lock was
 * taken over stops writing at its next batch instead of resurrecting rows or a cursor the run
 * that took over has cleared. Throws {@link WorkflowVisibilityBackfillInProgressError} when the
 * lock is no longer this run's, and returns `'conflict'` when only an extra condition failed. On
 * a backend without `conditionalBatch`, which only `--drop` accepts, the batch is unfenced.
 */
async function commitUnderLock(
  storage: Storage,
  lockToken: Uint8Array,
  operations: BatchOperation[],
  conditions: ConditionalBatchCondition[] = [],
): Promise<'committed' | 'conflict'> {
  if (!storage.capabilities().conditionalBatch) {
    await storage.batch(operations);
    return 'committed';
  }
  const committed = await storageConditionalBatch(
    storage,
    [...conditions, { key: KEYS.workflowVisibilityMetaBuilding(), expectedValue: lockToken }],
    operations,
  );
  if (committed) return 'committed';
  if (!(await holdsBackfillLock(storage, lockToken))) {
    throw new WorkflowVisibilityBackfillInProgressError();
  }
  return 'conflict';
}

async function holdsBackfillLock(storage: Storage, lockToken: Uint8Array): Promise<boolean> {
  const held = await storage.get(KEYS.workflowVisibilityMetaBuilding());
  return held !== null && Buffer.from(held).equals(Buffer.from(lockToken));
}

/**
 * Drop every visibility-index row plus the watermark. Order is load-bearing:
 * the watermark goes first so engines fall back to the slow path once they
 * re-read it; the script waits that out, then the rows themselves are removed,
 * then the cursor is cleared. Reversing this order would leave a window where
 * an engine trusts a watermark for indexes that no longer exist. The drop holds
 * the backfill lock under its own token for the whole run, so no backfill can
 * start and publish a watermark over rows the drop has not yet swept. Taking
 * the lock overwrites whatever held it, which is how a run that was killed
 * outright is recovered, and a backfill still running when that happens
 * cannot publish its watermark afterwards.
 */
export async function runWorkflowVisibilityDrop(
  storage: Storage,
  options: {
    logger?: BackfillLogger;
    fallbackBatchSize?: number;
    /** See {@link WorkflowVisibilityBackfillOptions.settleMilliseconds}. */
    settleMilliseconds?: number;
  } = {},
): Promise<DropReport> {
  const logger = options.logger ?? (() => undefined);
  const fallbackBatchSize = options.fallbackBatchSize ?? 500;

  // Take the lock unconditionally and hold it until the sweep and the cursor
  // cleanup finish. Overwriting it is how a lock a killed run left is cleared,
  // and it stops a backfill that is still running from publishing; holding it
  // keeps a new backfill from claiming the key and publishing a watermark over
  // rows this drop has not finished deleting.
  const dropToken = encode(crypto.randomUUID());
  await storage.put(KEYS.workflowVisibilityMetaBuilding(), dropToken);
  try {
    await commitUnderLock(storage, dropToken, WATERMARK_REMOVAL);
    await settle(
      options.settleMilliseconds ?? WORKFLOW_VISIBILITY_BACKFILL_SETTLE_MILLISECONDS,
      logger,
      'stop trusting the visibility index',
    );

    const rowsDeleted = await sweepVisibilityIndexRows(
      storage,
      logger,
      fallbackBatchSize,
      dropToken,
    );
    await commitUnderLock(storage, dropToken, [
      { type: 'delete', key: KEYS.workflowVisibilityMetaCursor() },
    ]);
    return { rowsDeleted };
  } finally {
    await releaseBackfillLock(storage, dropToken);
  }
}

/** Remove the lock only if it still holds `token`, so a run never releases another run's lock. */
async function releaseBackfillLock(storage: Storage, token: Uint8Array): Promise<void> {
  if (storage.capabilities().conditionalBatch) {
    await storageConditionalBatch(
      storage,
      [{ key: KEYS.workflowVisibilityMetaBuilding(), expectedValue: token }],
      [{ type: 'delete', key: KEYS.workflowVisibilityMetaBuilding() }],
    );
    return;
  }
  if (await holdsBackfillLock(storage, token)) {
    await storage.delete(KEYS.workflowVisibilityMetaBuilding());
  }
}

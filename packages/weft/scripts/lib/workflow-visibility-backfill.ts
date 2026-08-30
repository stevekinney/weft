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
  buildWorkflowVisibilityIndexOperations,
  decodeWorkflowVisibilityManifest,
} from '../../src/core/engine/workflow-indexes.ts';
import {
  KEYS,
  storageConditionalBatch,
  tryDecodeStorageKeyComponent,
  type BatchOperation,
  type Storage,
} from '../../src/storage/interface.ts';

const VISIBILITY_INDEX_PREFIXES = [
  'wf-idx-status:',
  'wf-idx-type:',
  'wf-idx-tenant:',
  'wf-idx-created:',
  'wf-idx-updated:',
  'wf-idx-deadline:',
  'wf-idx-manifest:',
];

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
};

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
 * pass, in which case the caller should re-run the backfill.
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

  const startCursor = await loadCursor(storage);
  if (startCursor !== undefined) {
    logger(`Resuming backfill from cursor ${startCursor}`);
  }

  let processed = 0;
  let conflicts = 0;
  const scanOptions = startCursor !== undefined ? { gt: startCursor } : undefined;

  for await (const [key, value] of storage.scan('wf:', scanOptions)) {
    if (!isTopLevelWorkflowKey(key)) continue;
    const workflowId = tryDecodeStorageKeyComponent(key.slice(3));
    if (workflowId === null) continue;

    const state = decodeWorkflowState(value);
    const manifestBytes = await storage.get(KEYS.workflowVisibilityManifest(workflowId));
    const currentManifest = decodeWorkflowVisibilityManifest(manifestBytes);
    const { batchOps } = buildWorkflowVisibilityIndexOperations(workflowId, currentManifest, state);

    const operations: BatchOperation[] = [
      ...batchOps,
      {
        type: 'put',
        key: KEYS.workflowVisibilityMetaCursor(),
        value: encode(key),
      },
    ];
    const committed = await storageConditionalBatch(
      storage,
      [{ key, expectedValue: value }],
      operations,
    );
    if (!committed) {
      conflicts += 1;
      logger(`Conflict on workflow ${workflowId}; will retry on next pass.`);
      continue;
    }

    processed += 1;
    if (processed % checkpointEvery === 0) {
      logger(`Processed ${processed} workflows (last: ${workflowId})`);
    }
  }

  if (conflicts > 0) {
    logger(
      `Backfill saw ${conflicts} conditional-batch conflicts. Re-run to process those workflows.`,
    );
    return { processed, conflicts, watermarkWritten: false };
  }

  // Advance the watermark and clear the cursor atomically. The engine
  // either sees the new index version with no in-progress marker, or it
  // sees neither — never the partial state.
  await storage.batch([
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

/**
 * Drop every visibility-index row plus the watermark. Order is
 * load-bearing: the watermark goes first so the engine immediately
 * falls back to the slow path while the rows are being swept, then the
 * rows themselves are removed, then the cursor is cleared. Reversing
 * this order would leave a window where the engine trusts a watermark
 * for indexes that no longer exist.
 */
export async function runWorkflowVisibilityDrop(
  storage: Storage,
  options: { logger?: BackfillLogger; fallbackBatchSize?: number } = {},
): Promise<DropReport> {
  const logger = options.logger ?? (() => undefined);
  const fallbackBatchSize = options.fallbackBatchSize ?? 500;

  await storage.delete(KEYS.workflowVisibilityMetaVersion());
  await storage.delete(KEYS.workflowVisibilityMetaBuiltAt());

  let rowsDeleted = 0;
  for (const prefix of VISIBILITY_INDEX_PREFIXES) {
    if (storage.deletePrefix !== undefined) {
      const removed = await storage.deletePrefix(prefix);
      rowsDeleted += removed;
      logger(`Dropped prefix ${prefix} (${removed} rows)`);
      continue;
    }
    const toDelete: BatchOperation[] = [];
    for await (const [key] of storage.scan(prefix)) {
      toDelete.push({ type: 'delete', key });
      if (toDelete.length >= fallbackBatchSize) {
        await storage.batch(toDelete);
        rowsDeleted += toDelete.length;
        toDelete.length = 0;
      }
    }
    if (toDelete.length > 0) {
      await storage.batch(toDelete);
      rowsDeleted += toDelete.length;
    }
  }

  await storage.delete(KEYS.workflowVisibilityMetaCursor());
  return { rowsDeleted };
}

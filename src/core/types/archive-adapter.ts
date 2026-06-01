/**
 * Operator-supplied hook for archiving event-log records that event-log
 * compaction is about to discard.
 *
 * @module core/types/archive-adapter
 */

/**
 * An operator-supplied object-store sink for compacted event-log ranges.
 *
 * When an {@link ArchiveAdapter} is configured (via `EngineOptions.archive`),
 * event-log compaction serializes each deleted range and calls {@link store}
 * **after** the truncation has committed durably.
 *
 * > [!WARNING]
 * > This is a best-effort **export notification, not a durability guarantee.**
 * > The deleted records are removed from primary storage regardless of whether
 * > `store` resolves, rejects, or throws — compaction never rolls back on an
 * > archive failure. Operators who need guaranteed archival must implement
 * > their own durability before the records are compacted (the engine does not
 * > provide a pre-deletion durability barrier).
 *
 * @example
 * ```ts
 * import type { ArchiveAdapter } from '@lostgradient/weft';
 *
 * const adapter: ArchiveAdapter = {
 *   async store(workflowId, key, bytes) {
 *     // e.g. write `bytes` to object storage under `${workflowId}/${key}`
 *     void workflowId;
 *     void key;
 *     void bytes;
 *   },
 * };
 * void adapter;
 * ```
 */
export type ArchiveAdapter = {
  /**
   * Persist a serialized, compacted event-log range.
   *
   * @param workflowId  The workflow whose history was compacted.
   * @param key         A range identifier of the form `events:{from}-{to}`
   *   (inclusive sequence bounds of the deleted records). The adapter owns its
   *   own storage namespace; this key is not a `weft` storage key.
   * @param bytes       The serialized deleted records (see
   *   `serializeDeletedEntries`).
   */
  store(workflowId: string, key: string, bytes: Uint8Array): Promise<void>;
};

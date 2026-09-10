/**
 * Resolves durable `catalog-tombstone:<name>:<revision>` records left
 * behind by {@link import('../catalog/removal.ts').removeCatalogEntry}
 * (WFT-17/18, Codex review on PR #958) — a tombstone exists only in the
 * brief window between its delete-and-tombstone commit and the SAME call's
 * own resolution (restore or finalize), normally sub-millisecond. A
 * tombstone that outlives that window is an ORPHAN: the process that
 * created it crashed (or otherwise failed) before resolving it. This
 * module makes that recoverable by ANY process, not just the one that
 * crashed — the exact gap the tombstone design closes (see
 * `core/catalog/removal.ts`'s module doc for the full mechanism).
 *
 * Deliberately lives in `core/engine/`, not alongside the tombstone
 * primitives in `core/catalog/`: resolving an orphan needs a FRESH
 * reference count, and the only reference signals meaningful for a
 * crashed peer's tombstone are the durable ones —
 * `nonterminal-revision-count.ts`'s `wf:`-prefix scan (both the
 * non-terminal AND terminal-but-unpurged buckets, WFT-17/WFT-21),
 * `pinned-schedule-revision-count.ts`'s `schedule:`-prefix scan (WFT-20),
 * and `retained-recovery-record-count.ts`'s `wf-teardown-deadletter:`-prefix
 * scan (WFT-21) — in-process signals like
 * `registeredDefinitions`/`inFlightStarts` are per-engine-instance and say
 * nothing about what a DIFFERENT, crashed process was doing. Before WFT-21
 * this sweep checked ONLY `nonTerminalRuns`, silently ignoring a pinned
 * schedule or a terminal/dead-lettered reference — a pre-existing gap
 * fixed alongside this batch's own `retainedRecoveryRecords` wiring, since
 * both are the same class of durable-reference check.
 * `core/catalog/**` never imports from `core/engine/**` — a directional
 * boundary `check-import-cycles.ts` enforces — so this orchestration has to
 * live on the engine side of that line.
 *
 * Two call sites: `catalog-readiness.ts`'s boot-time sweep (every
 * orphaned tombstone in the whole store, run once per engine instance
 * before recovery or any new start can observe stale state) and
 * `catalog-removal.ts`'s `removeWorkflowRevision` (a single, targeted
 * check for the EXACT `(name, revision)` key it is about to act on, since
 * a long-lived engine could observe a peer crash mid-lifetime, after its
 * own boot sweep already ran).
 *
 * @module core/engine/catalog-tombstone-recovery
 */

import { KEYS, type Storage } from '../../storage/interface.ts';
import { tryDecodeStorageKeyComponent } from '../../storage/key-encoding.ts';
import {
  decodeCatalogEntryRecord,
  finalizeCatalogTombstone,
  restoreCatalogEntryFromTombstone,
} from '../catalog/index.ts';
import { countWorkflowStateRevisionsByStatus } from './nonterminal-revision-count.ts';
import { countPinnedSchedulesForRevision } from './pinned-schedule-revision-count.ts';
import { countTeardownDeadLettersForRevision } from './retained-recovery-record-count.ts';

function splitCatalogTombstoneKey(key: string): { name: string; revision: string } | null {
  const parts = key.split(':');
  if (parts.length !== 3) return null;
  const name = tryDecodeStorageKeyComponent(parts[1] ?? '');
  const revision = tryDecodeStorageKeyComponent(parts[2] ?? '');
  if (name === null || revision === null) return null;
  return { name, revision };
}

/**
 * Resolve one tombstone from a fresh durable reference count across all
 * three storage-scan-backed reference kinds `removeWorkflowRevision()`
 * itself checks (WFT-21 — see `catalog-removal.ts`'s own doc for why these,
 * and only these, are meaningful for a crashed peer): zero non-terminal
 * runs, zero pinned schedules, and zero retained recovery records
 * (terminal-but-unpurged runs plus dead letters) pinned to `(name,
 * revision)` finalizes the tombstone (completes the removal); any of the
 * three being nonzero restores the entry instead. CAS'd on `tombstoneBytes`
 * in both directions, so losing the race to a concurrent resolver (this
 * process's own targeted check, another process's boot sweep, or the
 * original caller finishing normally) is a harmless no-op — never an
 * error, never double-processed.
 *
 * **Known limitation, documented rather than fixed (self-audit following
 * Codex review round 10):** all three counts below propagate an
 * undecodable durable record as a thrown error rather than a value — none
 * of `decodeWorkflowState()`, `decodeScheduleState()`, or (since round 10)
 * `countTeardownDeadLettersForRevision()`'s own `decode()` call is guarded.
 * For {@link resolveCatalogTombstoneIfPresent}'s targeted, operator-invoked
 * call this is exactly the desired fail-closed behavior. For the BOOT-TIME
 * sweep (`resolveOrphanedCatalogTombstones()`, called from
 * `ensureWorkflowCatalogReady()` with no surrounding try/catch), the same
 * propagation means one undecodable record anywhere in the relevant scan —
 * not necessarily related to the orphan actually being resolved — blocks
 * `internals.catalogRestored` from ever becoming `true`, so every future
 * `start`/`resume`/`fork`/recovery call retries and re-hits the identical
 * failure. This is a pre-existing property of the boot sweep (present for
 * `WorkflowState`/schedule decode failures since WFT-12/17/20); round 10
 * only removed dead letters' status as the one scan that disagreed with it
 * by silently under-counting instead. Whether the boot sweep should isolate
 * a per-tombstone reference-count failure (skip, log, continue) rather than
 * block ALL catalog readiness is a genuine design question, left open — see
 * the CHANGELOG entry alongside the round-10 dead-letter fix for the full
 * writeup.
 */
async function resolveCatalogTombstone(
  storage: Storage,
  name: string,
  revision: string,
  tombstoneBytes: Uint8Array,
): Promise<void> {
  const { nonTerminalRuns, terminalRuns } = await countWorkflowStateRevisionsByStatus(
    storage,
    name,
    revision,
  );
  const pinnedSchedules = await countPinnedSchedulesForRevision(storage, name, revision);
  const deadLetters = await countTeardownDeadLettersForRevision(storage, name, revision);
  const referenced = nonTerminalRuns + pinnedSchedules + terminalRuns + deadLetters > 0;
  if (referenced) {
    await restoreCatalogEntryFromTombstone(storage, name, revision, tombstoneBytes);
  } else {
    await finalizeCatalogTombstone(storage, name, revision, tombstoneBytes);
  }
}

/**
 * Sweep every `catalog-tombstone:` record in `storage` and resolve each
 * one. Bounded by the number of orphaned tombstones actually present —
 * normally zero, so this is a cheap prefix scan that yields nothing to
 * iterate; only non-trivial after a real crash left orphans behind. Called
 * once per engine instance, at catalog-boot time
 * (`catalog-readiness.ts`), before recovery's own preflight or any fresh
 * start can observe a revision this sweep would otherwise still be
 * resolving.
 */
export async function resolveOrphanedCatalogTombstones(storage: Storage): Promise<void> {
  for await (const [key, bytes] of storage.scan(KEYS.catalogTombstonePrefix())) {
    const split = splitCatalogTombstoneKey(key);
    if (split === null) {
      throw new Error(
        `The store's catalog tombstone key ("${key}") does not match the expected ` +
          'catalog-tombstone:<name>:<revision> shape. Treating it as absent would risk silently ' +
          'abandoning an in-flight catalog removal, so this fails closed instead. Resolve by ' +
          'operator repair: inspect the stored bytes and, only if certain no removal is actually ' +
          'in flight, delete the key.',
      );
    }
    // Validates the tombstone's own bytes decode as a real catalog-entry
    // record — the same fail-closed precedent every other durable catalog
    // read in this codebase follows (`restoreWorkflowCatalog`,
    // `readCatalogEntry`); the decoded manifest itself is not needed here,
    // only the validation that `tombstoneBytes` is a real, restorable entry.
    await decodeCatalogEntryRecord(key, bytes, split.name, split.revision);
    await resolveCatalogTombstone(storage, split.name, split.revision, bytes);
  }
}

/**
 * Targeted check for ONE `(name, revision)` tombstone — used by
 * `removeWorkflowRevision` immediately before it acts, so a peer crash
 * that happened after this engine's own boot-time sweep already ran (a
 * long-lived engine) does not leave a stale tombstone permanently blocking
 * every future removal attempt on that exact key (`removeCatalogEntry`'s
 * own CAS requires the tombstone key absent). A no-op when no tombstone is
 * present for this exact key — the overwhelmingly common case, costing one
 * `storage.get`.
 */
export async function resolveCatalogTombstoneIfPresent(
  storage: Storage,
  name: string,
  revision: string,
): Promise<void> {
  const tombstoneKey = KEYS.catalogTombstone(name, revision);
  const tombstoneBytes = await storage.get(tombstoneKey);
  if (tombstoneBytes === null) return;
  await decodeCatalogEntryRecord(tombstoneKey, tombstoneBytes, name, revision);
  await resolveCatalogTombstone(storage, name, revision, tombstoneBytes);
}

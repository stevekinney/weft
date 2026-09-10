/**
 * Count durable `TeardownDeadLetterRecord`s pinned to an exact
 * `(type, revision)` (WFT-21). Wired into `catalog-removal.ts`'s
 * `countWorkflowRevisionReferences()`, contributing one of the two
 * components of `retainedRecoveryRecords` — the other being terminal,
 * unpurged `WorkflowState`s (see
 * {@link import('./nonterminal-revision-count.ts').countWorkflowStateRevisionsByStatus}'s
 * `terminalRuns`).
 *
 * A dead letter is deliberately excluded from the workflow purge delete-set
 * (leak evidence, per `termination/finalizer-claim.ts`'s
 * `KEYS.teardownDeadLetter` doc) and so, unlike a terminal `WorkflowState`,
 * is NEVER auto-released by purge or retention — a revision that ever
 * dead-lettered stays permanently non-removable until a future
 * acknowledge/clear API exists (not built this batch).
 *
 * Scans `KEYS.teardownDeadLetterHistoryPrefix()`, NOT
 * `KEYS.teardownDeadLetterPrefix()` (WFT-21, Codex review round 3, P2): the
 * latter is a single slot per workflow id, so a workflow id reused across
 * generations (purge, or `onTerminalConflict: 'start-new'`) would have a
 * LATER generation's dead letter silently overwrite an EARLIER generation's
 * at that slot — destroying the earlier generation's revision reference
 * this scan exists to protect. The history namespace is keyed additionally
 * by `workflowExecutionToken`, so every generation's record survives
 * independently — see `KEYS.teardownDeadLetterHistory`'s own doc.
 *
 * Mirrors `pinned-schedule-revision-count.ts`'s bounded-scan shape and doc
 * style.
 *
 * @module core/engine/retained-recovery-record-count
 */

import { KEYS, type Storage } from '../../storage/interface.ts';
import { decodeStorageKeyComponent } from '../../storage/key-encoding.ts';
import { decode } from '../codec.ts';
import { isRecord } from '../debug-output.ts';
import { LEGACY_DEAD_LETTER_HISTORY_TOKEN } from './termination/finalizer-claim.ts';

/**
 * Scan `storage` for `TeardownDeadLetterRecord`s whose `type` and
 * `revision` match exactly, returning the count. A record with
 * `revision === undefined` (written before this field existed, or for a
 * legacy run with no persisted `WorkflowState.revision`) never matches a
 * defined `revision` argument — it never counts against any specific
 * revision, mirroring `nonTerminalRuns`' own legacy-record precedent.
 *
 * Deliberately does NOT catch a `decode()` failure (Codex review round 10,
 * P2): an EARLIER version of this scan caught and silently skipped an
 * undecodable record — reachable in a supported multi-process
 * `ownership: 'workflow-lease'` deployment whenever a peer or operator
 * process scans a dead letter whose `finalizerInput` used a custom
 * serializer tag THIS process has not registered. That skip let reference
 * accounting under-count (or read zero), permitting `removeWorkflowRevision()`
 * to remove a revision this exact dead letter still durably pins — directly
 * defeating the "dead-letter evidence pins its revision permanently" contract
 * this module's own top-of-file doc states. `decode()` is now called
 * unguarded, matching `nonterminal-revision-count.ts`'s own sibling
 * convention for `WorkflowState` records: an undecodable record fails the
 * WHOLE scan closed (the caller sees a rejected promise, not a falsely-safe
 * lower count), forcing an operator to resolve the undecodable record — e.g.
 * by registering the missing extension codec — before removal can proceed,
 * rather than silently letting removal race ahead of evidence it could not
 * read. `pinned-schedule-revision-count.ts` was checked for the identical
 * class of bug and does not have it: its own `decode()` call is likewise
 * unguarded (its `if (!state) continue` skip is a SEPARATE, narrower check —
 * successfully decoded bytes that fail schema validation, not an undecodable
 * blob).
 *
 * Also scans {@link KEYS.teardownDeadLetterPrefix}, the legacy single-slot
 * namespace (Codex review, item 7): `deadLetterTeardown()` writes the
 * single-slot key and its history sibling TOGETHER on every current write,
 * but a record written by a pre-upgrade process (before the history sibling
 * existed at all) survives ONLY under the single-slot key. Once that run's
 * `WorkflowState` is purged, such a record is the sole remaining evidence
 * the revision was ever referenced — without this second scan, reference
 * accounting would silently read zero and let `removeWorkflowRevision()`
 * remove a revision this exact dead letter still pins, defeating this
 * module's own permanent-pin contract. A single-slot record whose computed
 * history key already exists is skipped here — it is a current-format write
 * already counted by the history scan above, so counting it again here
 * would double-count it. A record with NO `workflowExecutionToken` is
 * pinned conservatively: `deadLetterTeardown()`'s own fixed
 * {@link LEGACY_DEAD_LETTER_HISTORY_TOKEN} fallback segment means a second
 * token-less generation for the same workflow id can silently overwrite an
 * earlier one at that same sentinel slot (see that constant's own doc), so
 * the single "does a history sibling exist" check is not reliable evidence
 * for a token-less record the way it is for a token-bearing one — such a
 * record counts toward EVERY queried revision of the matching type, rather
 * than risking an under-count from a revision comparison this scan cannot
 * fully trust.
 */
export async function countTeardownDeadLettersForRevision(
  storage: Storage,
  type: string,
  revision: string,
): Promise<number> {
  let count = 0;
  for await (const [, bytes] of storage.scan(KEYS.teardownDeadLetterHistoryPrefix())) {
    const decoded = decode(bytes);
    if (!isRecord(decoded)) continue;
    if (decoded['type'] !== type || decoded['revision'] !== revision) continue;
    count += 1;
  }

  for await (const [key, bytes] of storage.scan(KEYS.teardownDeadLetterPrefix())) {
    if (await countLegacySingleSlotDeadLetter(storage, key, bytes, type, revision)) {
      count += 1;
    }
  }

  return count;
}

/**
 * Decide whether one legacy single-slot `wf-teardown-deadletter:` record
 * (see {@link countTeardownDeadLettersForRevision}'s own doc for the "why")
 * counts toward `(type, revision)`. Extracted to keep the caller's
 * complexity bounded.
 */
async function countLegacySingleSlotDeadLetter(
  storage: Storage,
  key: string,
  bytes: Uint8Array,
  type: string,
  revision: string,
): Promise<boolean> {
  const decoded = decode(bytes);
  if (!isRecord(decoded) || decoded['type'] !== type) return false;

  const workflowId = decodeStorageKeyComponent(key.slice(KEYS.teardownDeadLetterPrefix().length));
  const token =
    typeof decoded['workflowExecutionToken'] === 'string'
      ? decoded['workflowExecutionToken']
      : undefined;
  const historyKey = KEYS.teardownDeadLetterHistory(
    workflowId,
    token ?? LEGACY_DEAD_LETTER_HISTORY_TOKEN,
  );
  const alreadyCountedViaHistory = (await storage.get(historyKey)) !== null;
  if (alreadyCountedViaHistory) return false;

  // Conservative pin: cannot reliably correlate a token-less record to a
  // specific revision (see the doc above), so it counts for every query.
  if (token === undefined) return true;

  return decoded['revision'] === revision;
}

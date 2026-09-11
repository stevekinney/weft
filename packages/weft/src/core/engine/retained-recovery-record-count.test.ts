import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { encode } from '../codec.ts';
import { countTeardownDeadLettersForRevision } from './retained-recovery-record-count.ts';
import type { TeardownDeadLetterRecord } from './termination/finalizer-claim.ts';

function makeDeadLetter(
  overrides: Partial<TeardownDeadLetterRecord> & { type: string },
): TeardownDeadLetterRecord {
  return {
    lastError: 'boom',
    attempts: 8,
    deadLetteredAt: 1,
    ...overrides,
  };
}

/**
 * Seed a dead letter under `teardownDeadLetterHistory` — the namespace
 * `countTeardownDeadLettersForRevision()` actually scans (WFT-21, Codex
 * review round 3, P2) — keyed by `workflowExecutionToken` when the record
 * carries one, or a fixed per-call fallback otherwise, so two calls for the
 * SAME `workflowId` (simulating id reuse across generations) never collide
 * unless the caller passes the same token/fallback on purpose.
 */
async function seedDeadLetter(
  storage: MemoryStorage,
  workflowId: string,
  record: TeardownDeadLetterRecord,
  fallbackToken = workflowId,
): Promise<void> {
  await storage.put(
    KEYS.teardownDeadLetterHistory(workflowId, record.workflowExecutionToken ?? fallbackToken),
    encode(record),
  );
}

describe('countTeardownDeadLettersForRevision', () => {
  it('counts only dead letters whose (type, revision) match exactly', async () => {
    const storage = new MemoryStorage();
    await seedDeadLetter(storage, 'wf-1', makeDeadLetter({ type: 'checkout', revision: 'rev-a' }));
    // Different revision of the same type — must not count.
    await seedDeadLetter(storage, 'wf-2', makeDeadLetter({ type: 'checkout', revision: 'rev-b' }));
    // Different type, same revision string — must not count.
    await seedDeadLetter(storage, 'wf-3', makeDeadLetter({ type: 'other', revision: 'rev-a' }));

    expect(await countTeardownDeadLettersForRevision(storage, 'checkout', 'rev-a')).toBe(1);
  });

  it('a history dead letter with a legitimately absent revision is pinned conservatively toward every queried revision of the matching type, exactly like the single-slot fallback (WFT-21, Codex review round 14, P2 item TH4X)', async () => {
    const storage = new MemoryStorage();
    // A pre-revision-pinning workflow recovered and later dead-lettered
    // under this version: `deadLetterTeardown()` wrote this history record
    // with no `revision` field at all. Before this fix,
    // `decoded['revision'] !== revision` was `true` for every queried
    // revision when the record's own revision was `undefined`, silently
    // excluding it from every query — once the workflow's `WorkflowState`
    // is purged, this history record is the sole remaining evidence the
    // revision was ever referenced.
    await seedDeadLetter(storage, 'wf-legacy', makeDeadLetter({ type: 'checkout' }));

    expect(await countTeardownDeadLettersForRevision(storage, 'checkout', 'rev-a')).toBe(1);
    expect(await countTeardownDeadLettersForRevision(storage, 'checkout', 'rev-b')).toBe(1);
    // A different type must still be excluded.
    expect(await countTeardownDeadLettersForRevision(storage, 'other', 'rev-a')).toBe(0);
  });

  it('sums multiple dead letters for the same (type, revision)', async () => {
    const storage = new MemoryStorage();
    await seedDeadLetter(storage, 'wf-1', makeDeadLetter({ type: 'checkout', revision: 'rev-a' }));
    await seedDeadLetter(storage, 'wf-2', makeDeadLetter({ type: 'checkout', revision: 'rev-a' }));

    expect(await countTeardownDeadLettersForRevision(storage, 'checkout', 'rev-a')).toBe(2);
  });

  it('returns 0 when no dead letters are present', async () => {
    const storage = new MemoryStorage();
    expect(await countTeardownDeadLettersForRevision(storage, 'checkout', 'rev-a')).toBe(0);
  });

  it('fails the whole scan closed on an undecodable record, rather than silently skipping it and under-counting (WFT-21, Codex review round 10, P2, superseding the earlier skip-and-continue behavior)', async () => {
    const storage = new MemoryStorage();
    // `0xc1` is msgpack's reserved "never used" byte — guaranteed to throw on
    // decode, standing in for a record written with a custom `finalizerInput`
    // serializer tag this process has never registered (Codex's own scenario:
    // a peer or operator process in a multi-process `workflow-lease`
    // deployment scanning a dead letter it cannot fully decode).
    await storage.put(
      KEYS.teardownDeadLetterHistory('wf-corrupt', 'corrupt-token'),
      new Uint8Array([0xc1]),
    );
    await seedDeadLetter(
      storage,
      'wf-good',
      makeDeadLetter({ type: 'checkout', revision: 'rev-a' }),
    );

    // Before the fix, this resolved to `1` — silently skipping the
    // undecodable record and reporting only the decodable one, which let
    // `removeWorkflowRevision()` treat a revision an undecodable-but-real
    // dead letter still pins as safe to remove. It must now reject outright,
    // regardless of which OTHER records in the same scan were decodable.
    await expect(
      countTeardownDeadLettersForRevision(storage, 'checkout', 'rev-a'),
    ).rejects.toThrow();
  });

  it('fails the whole scan closed on a history record that decodes successfully but is structurally malformed, rather than silently skipping it AND letting it suppress a legitimate legacy single-slot sibling (WFT-21, Codex review round 13, P2)', async () => {
    const storage = new MemoryStorage();
    // A history record that decodes fine but is not a well-formed
    // `TeardownDeadLetterRecord` at all — `isRecord()` rejects it, so the
    // pre-fix behavior silently `continue`s past it in the history scan.
    await storage.put(KEYS.teardownDeadLetterHistory('wf-malformed', 'tok'), encode(null));

    // A LEGITIMATE legacy single-slot record for the SAME workflow id and
    // token, matching (type, revision) — this is the actual evidence this
    // scan exists to find. Before the fix,
    // `countLegacySingleSlotDeadLetter()`'s `alreadyCountedViaHistory` check
    // only tests whether the history KEY exists (`storage.get(historyKey)
    // !== null`), never whether its CONTENT is valid — the malformed
    // record's key existing was enough to wrongly suppress this single-slot
    // sibling as "already counted", so neither record ever counted and
    // `removeWorkflowRevision()` would see zero references despite this
    // dead letter still durably pinning the revision.
    await storage.put(
      KEYS.teardownDeadLetter('wf-malformed'),
      encode(
        makeDeadLetter({
          type: 'checkout',
          revision: 'rev-a',
          workflowExecutionToken: 'tok',
        }),
      ),
    );

    await expect(
      countTeardownDeadLettersForRevision(storage, 'checkout', 'rev-a'),
    ).rejects.toThrow();
  });

  it("retains an earlier generation's dead-letter revision reference after the workflow id is reused (WFT-21, Codex review round 3, P2)", async () => {
    const storage = new MemoryStorage();
    // Two generations of the SAME workflow id — a real `start-new`/purge id-reuse
    // scenario — each dead-lettering under a DIFFERENT revision of the same
    // type. Before this fix, `deadLetterTeardown()` wrote both records to the
    // single `KEYS.teardownDeadLetter(workflowId)` slot, so the second
    // generation's write would silently destroy the first generation's
    // evidence and reference count. The history namespace keys each
    // generation by its own `workflowExecutionToken`, so neither write
    // collides with the other.
    await seedDeadLetter(
      storage,
      'wf-reused',
      makeDeadLetter({
        type: 'checkout',
        revision: 'rev-a',
        workflowExecutionToken: 'generation-1-token',
      }),
    );
    await seedDeadLetter(
      storage,
      'wf-reused',
      makeDeadLetter({
        type: 'checkout',
        revision: 'rev-b',
        workflowExecutionToken: 'generation-2-token',
      }),
    );

    expect(await countTeardownDeadLettersForRevision(storage, 'checkout', 'rev-a')).toBe(1);
    expect(await countTeardownDeadLettersForRevision(storage, 'checkout', 'rev-b')).toBe(1);
  });

  it('a legacy dead letter with no workflowExecutionToken uses a fixed history fallback segment, so a second legacy generation for the same id can still collide (documented bounded edge case)', async () => {
    const storage = new MemoryStorage();
    await storage.put(
      KEYS.teardownDeadLetterHistory('wf-legacy-reused', 'legacy'),
      encode(makeDeadLetter({ type: 'checkout', revision: 'rev-a' })),
    );
    // A second legacy (no-token) generation for the SAME id dead-lettering
    // under a DIFFERENT revision collides on the same fallback segment —
    // this is the documented, bounded exception, not a regression.
    await storage.put(
      KEYS.teardownDeadLetterHistory('wf-legacy-reused', 'legacy'),
      encode(makeDeadLetter({ type: 'checkout', revision: 'rev-b' })),
    );

    expect(await countTeardownDeadLettersForRevision(storage, 'checkout', 'rev-a')).toBe(0);
    expect(await countTeardownDeadLettersForRevision(storage, 'checkout', 'rev-b')).toBe(1);
  });

  it('counts a pre-upgrade dead letter that exists ONLY under the legacy single-slot namespace, with no history sibling, after its WorkflowState is purged (WFT-21, Codex review, item 7)', async () => {
    const storage = new MemoryStorage();
    // Pre-upgrade write: `deadLetterTeardown()` writes both keys together
    // today, but this record predates that (round 3) change, so only the
    // single-slot key exists. Its `WorkflowState` has since been purged, so
    // this record is the ONLY surviving evidence the revision was ever
    // referenced.
    await storage.put(
      KEYS.teardownDeadLetter('wf-preupgrade'),
      encode(
        makeDeadLetter({ type: 'checkout', revision: 'rev-a', workflowExecutionToken: 'tok-1' }),
      ),
    );

    expect(await countTeardownDeadLettersForRevision(storage, 'checkout', 'rev-a')).toBe(1);
  });

  it('does not double-count a current-format single-slot record already covered by the history scan', async () => {
    const storage = new MemoryStorage();
    const record = makeDeadLetter({
      type: 'checkout',
      revision: 'rev-a',
      workflowExecutionToken: 'tok-1',
    });
    // `deadLetterTeardown()` writes both keys together for every current
    // write, so a matching history record always accompanies the
    // single-slot one.
    await storage.put(KEYS.teardownDeadLetter('wf-current'), encode(record));
    await storage.put(KEYS.teardownDeadLetterHistory('wf-current', 'tok-1'), encode(record));

    expect(await countTeardownDeadLettersForRevision(storage, 'checkout', 'rev-a')).toBe(1);
  });

  it('conservatively pins a pre-upgrade single-slot orphan with a workflowExecutionToken but NO revision field for every queried revision of the matching type (WFT-21, Codex review, item 7 — the realistic pre-upgrade shape: workflowExecutionToken predates this PR, revision does not)', async () => {
    const storage = new MemoryStorage();
    // The realistic pre-upgrade record: `workflowExecutionToken` already
    // existed (added well before this PR), but `revision` did not — this
    // PR adds that field. A record this old still has NO history sibling
    // at all (the history write is also this PR's round 3), so it is
    // still a provable orphan by the "no history sibling" test, even
    // though it carries a token.
    await storage.put(
      KEYS.teardownDeadLetter('wf-preupgrade-token-no-revision'),
      encode(makeDeadLetter({ type: 'checkout', workflowExecutionToken: 'tok-preupgrade' })),
    );

    expect(await countTeardownDeadLettersForRevision(storage, 'checkout', 'rev-a')).toBe(1);
    expect(await countTeardownDeadLettersForRevision(storage, 'checkout', 'rev-b')).toBe(1);
    // A different type must still be excluded.
    expect(await countTeardownDeadLettersForRevision(storage, 'other', 'rev-a')).toBe(0);
  });

  it('conservatively pins a legacy single-slot record with no workflowExecutionToken and no revision for every queried revision of the matching type', async () => {
    const storage = new MemoryStorage();
    await storage.put(
      KEYS.teardownDeadLetter('wf-preupgrade-no-token'),
      encode(makeDeadLetter({ type: 'checkout' })),
    );

    expect(await countTeardownDeadLettersForRevision(storage, 'checkout', 'rev-a')).toBe(1);
    expect(await countTeardownDeadLettersForRevision(storage, 'checkout', 'rev-b')).toBe(1);
    // A different type must still be excluded.
    expect(await countTeardownDeadLettersForRevision(storage, 'other', 'rev-a')).toBe(0);
  });

  it('fails the whole scan closed on a single-slot record that decodes successfully but is not a well-formed record at all (WFT-21, Codex review round 14, P2 item TYSB)', async () => {
    const storage = new MemoryStorage();
    // Decodes fine (msgpack `null` is perfectly valid), but is not an
    // object at all — `countLegacySingleSlotDeadLetter()`'s pre-fix
    // `!isRecord(decoded) || decoded['type'] !== type` returned `false`
    // here (silently "unrelated"), even though this record's true `type`
    // cannot be determined at all and could be exactly the queried type.
    await storage.put(KEYS.teardownDeadLetter('wf-malformed-single-slot'), encode(null));

    await expect(
      countTeardownDeadLettersForRevision(storage, 'checkout', 'rev-a'),
    ).rejects.toThrow();
  });

  it('fails the whole scan closed on a single-slot record that decodes successfully as an object but is missing a string `type` field (WFT-21, Codex review round 14, P2 item TYSB)', async () => {
    const storage = new MemoryStorage();
    await storage.put(
      KEYS.teardownDeadLetter('wf-missing-type'),
      encode({ lastError: 'boom', attempts: 1, deadLetteredAt: 1 }),
    );

    await expect(
      countTeardownDeadLettersForRevision(storage, 'checkout', 'rev-a'),
    ).rejects.toThrow();
  });
});

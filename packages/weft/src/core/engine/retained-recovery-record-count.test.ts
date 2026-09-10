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

  it('a legacy dead letter with revision undefined never counts against any specific revision', async () => {
    const storage = new MemoryStorage();
    await seedDeadLetter(storage, 'wf-legacy', makeDeadLetter({ type: 'checkout' }));

    expect(await countTeardownDeadLettersForRevision(storage, 'checkout', 'rev-a')).toBe(0);
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
});

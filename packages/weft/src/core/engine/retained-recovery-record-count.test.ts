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

async function seedDeadLetter(
  storage: MemoryStorage,
  workflowId: string,
  record: TeardownDeadLetterRecord,
): Promise<void> {
  await storage.put(KEYS.teardownDeadLetter(workflowId), encode(record));
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

  it('skips an undecodable record rather than throwing', async () => {
    const storage = new MemoryStorage();
    await storage.put(KEYS.teardownDeadLetter('wf-corrupt'), new Uint8Array([0xc1]));
    await seedDeadLetter(
      storage,
      'wf-good',
      makeDeadLetter({ type: 'checkout', revision: 'rev-a' }),
    );

    expect(await countTeardownDeadLettersForRevision(storage, 'checkout', 'rev-a')).toBe(1);
  });
});

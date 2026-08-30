import { describe, expect, it } from 'bun:test';

import {
  appendRegistrationRejection,
  MAX_REGISTRATION_REJECTION_ENTRIES,
  recentRegistrationRejections,
  type RegistrationRejectionEntry,
} from './rejections.ts';

function entry(overrides: Partial<RegistrationRejectionEntry> = {}): RegistrationRejectionEntry {
  return { code: 'invalid_registration', rejectedAt: 0, ...overrides };
}

describe('appendRegistrationRejection', () => {
  it('appends to the log and returns it', () => {
    const log: RegistrationRejectionEntry[] = [];
    const result = appendRegistrationRejection(log, entry({ workerId: 'w-1' }));
    expect(result).toBe(log);
    expect(log).toEqual([entry({ workerId: 'w-1' })]);
  });

  it('evicts the oldest entry once the log exceeds the cap', () => {
    const log: RegistrationRejectionEntry[] = [];
    for (let i = 0; i < MAX_REGISTRATION_REJECTION_ENTRIES + 5; i++) {
      appendRegistrationRejection(log, entry({ workerId: `w-${i}`, rejectedAt: i }));
    }

    expect(log).toHaveLength(MAX_REGISTRATION_REJECTION_ENTRIES);
    expect(log[0]).toMatchObject({ workerId: 'w-5' });
    expect(log[log.length - 1]).toMatchObject({
      workerId: `w-${MAX_REGISTRATION_REJECTION_ENTRIES + 4}`,
    });
  });
});

describe('recentRegistrationRejections', () => {
  it('returns the requested number of entries, newest first', () => {
    const log: RegistrationRejectionEntry[] = [
      entry({ workerId: 'w-1', rejectedAt: 1 }),
      entry({ workerId: 'w-2', rejectedAt: 2 }),
      entry({ workerId: 'w-3', rejectedAt: 3 }),
    ];

    expect(recentRegistrationRejections(log, 2)).toEqual([
      entry({ workerId: 'w-3', rejectedAt: 3 }),
      entry({ workerId: 'w-2', rejectedAt: 2 }),
    ]);
  });

  it('returns every entry when limit exceeds the log length', () => {
    const log: RegistrationRejectionEntry[] = [entry({ workerId: 'w-1' })];
    expect(recentRegistrationRejections(log, 50)).toEqual([entry({ workerId: 'w-1' })]);
  });

  it('returns an empty array for an empty log', () => {
    expect(recentRegistrationRejections([], 10)).toEqual([]);
  });

  it('does not mutate the source log', () => {
    const log: RegistrationRejectionEntry[] = [
      entry({ workerId: 'w-1' }),
      entry({ workerId: 'w-2' }),
    ];
    recentRegistrationRejections(log, 1);
    expect(log).toHaveLength(2);
  });
});

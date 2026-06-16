import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { encode } from '../codec.ts';
import type { TimerEntry } from '../types.ts';
import {
  compareScannedTimerEntries,
  readNextTeardownTimerEntry,
  readNextTerminalCleanupTimerEntry,
  shouldDeleteTimerIndexWithoutLookup,
} from './timer-sources.ts';

async function* iterateEntries(
  entries: Array<[string, Uint8Array]>,
): AsyncGenerator<[string, Uint8Array]> {
  for (const entry of entries) {
    yield entry;
  }
}

function timerEntry(overrides: Partial<TimerEntry> = {}): TimerEntry {
  return {
    fireAt: 1_000,
    id: 'timer-1',
    kind: 'execution-deadline',
    workflowId: 'workflow-1',
    ...overrides,
  };
}

describe('timer sources', () => {
  it('orders scanned timer entries by fireAt before falling back to key order', () => {
    const earlier = { entry: timerEntry({ fireAt: 1_000 }), key: 'timer-a' };
    const later = { entry: timerEntry({ fireAt: 2_000 }), key: 'timer-b' };
    const sameTimeDifferentKey = { entry: timerEntry({ fireAt: 1_000 }), key: 'timer-z' };

    expect(compareScannedTimerEntries(earlier, later)).toBeLessThan(0);
    expect(compareScannedTimerEntries(sameTimeDifferentKey, earlier)).toBeGreaterThan(0);
  });

  it('drops corrupted terminal-cleanup timer entries before returning the next valid entry', async () => {
    const storage = new MemoryStorage();
    const corruptedKey = 'wf-cleanup:not-a-number:timer-1';
    const validKey = 'wf-cleanup:0000000000001000:cleanup-token';

    await storage.put(corruptedKey, encode('workflow-1'));

    const result = await readNextTerminalCleanupTimerEntry(
      iterateEntries([
        [corruptedKey, encode('workflow-1')],
        [validKey, encode('workflow-2')],
      ]),
      storage,
    );

    expect(result).toEqual({
      key: validKey,
      entry: {
        fireAt: 1_000,
        id: 'cleanup-token',
        kind: 'terminal-cleanup',
        workflowId: 'workflow-2',
      },
    });
    expect(await storage.get(corruptedKey)).toBeNull();
  });

  it('drops corrupted teardown timer entries before returning the next valid entry', async () => {
    const storage = new MemoryStorage();
    const corruptedKey = 'wf-teardown:0000000000001000:teardown-token';
    const validKey = 'wf-teardown:0000000000002000:teardown-next';

    await storage.put(corruptedKey, encode({ workflowId: 'not-a-string' }));

    const result = await readNextTeardownTimerEntry(
      iterateEntries([
        [corruptedKey, encode({ workflowId: 'not-a-string' })],
        [validKey, encode('workflow-2')],
      ]),
      storage,
    );

    expect(result).toEqual({
      key: validKey,
      entry: {
        fireAt: 2_000,
        id: 'teardown-next',
        kind: 'teardown',
        workflowId: 'workflow-2',
      },
    });
    expect(await storage.get(corruptedKey)).toBeNull();
  });

  it('deletes timer index entries without lookup only for workflow-scoped timers', () => {
    expect(shouldDeleteTimerIndexWithoutLookup(timerEntry({ kind: 'execution-deadline' }))).toBe(
      true,
    );
    expect(shouldDeleteTimerIndexWithoutLookup(timerEntry({ kind: 'terminal-cleanup' }))).toBe(
      false,
    );
    expect(shouldDeleteTimerIndexWithoutLookup(timerEntry({ kind: 'teardown' }))).toBe(false);
    expect(shouldDeleteTimerIndexWithoutLookup(timerEntry({ kind: 'schedule' }))).toBe(false);
  });
});

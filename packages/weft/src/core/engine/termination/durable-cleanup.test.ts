import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../../storage/interface.ts';
import { MemoryStorage } from '../../../storage/memory.ts';
import type { EngineInternals } from '../internals.ts';
import { cleanupTerminalWorkflowDurableState, type TerminationCallbacks } from './cleanup.ts';

const callbacks = { cleanupReviews: async () => {} } as unknown as TerminationCallbacks;

describe('cleanupTerminalWorkflowDurableState', () => {
  it('without a fence, sweeps unguarded and deletes the terminal-cleanup marker itself', async () => {
    const storage = new MemoryStorage();
    const internals = { storage } as unknown as EngineInternals;
    const marker = KEYS.terminalCleanupNeeded('w');
    const headers = KEYS.workflowHeaders('w');
    await storage.put(marker, new Uint8Array());
    await storage.put(headers, new Uint8Array([1]));

    await cleanupTerminalWorkflowDurableState(internals, 'w', false, callbacks);

    expect(await storage.get(marker)).toBeNull();
    expect(await storage.get(headers)).toBeNull();
  });
});

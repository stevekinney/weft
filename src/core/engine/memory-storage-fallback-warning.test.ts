/**
 * The Engine falls back to MemoryStorage when no `storage` is configured.
 * That fallback is silent in production but, in development, warns once so a
 * first-time user who crashes and restarts understands why their in-memory
 * workflow state vanished.
 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import {
  resolveEngineStorage,
  setMemoryStorageFallbackWarningOverrideForTesting,
} from './construction.ts';

const FALLBACK_PATTERN = /no `storage` configured.*MemoryStorage/s;

describe('MemoryStorage fallback warning', () => {
  afterEach(() => {
    setMemoryStorageFallbackWarningOverrideForTesting(undefined);
  });

  it('warns in development when no storage is configured', () => {
    setMemoryStorageFallbackWarningOverrideForTesting(true);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const storage = resolveEngineStorage();
      expect(storage).toBeInstanceOf(MemoryStorage);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatch(FALLBACK_PATTERN);
    } finally {
      warn.mockRestore();
    }
  });

  it('stays silent when storage is explicitly provided, even in development', () => {
    setMemoryStorageFallbackWarningOverrideForTesting(true);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const provided = new MemoryStorage();
      const storage = resolveEngineStorage({ storage: provided });
      expect(storage).toBe(provided);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('stays silent in production (gate off) even with no storage', () => {
    setMemoryStorageFallbackWarningOverrideForTesting(false);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const storage = resolveEngineStorage();
      expect(storage).toBeInstanceOf(MemoryStorage);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('warns via the explicit development:true option without the test override', () => {
    // No override → exercises the real gate. `development: true` is the
    // production-facing opt-in.
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      resolveEngineStorage({ development: true });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatch(FALLBACK_PATTERN);
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * The Engine falls back to MemoryStorage when no `storage` is configured.
 * That fallback is silent in production but, in development, warns once so a
 * first-time user who crashes and restarts understands why their in-memory
 * workflow state vanished.
 *
 * The dev gate is just the `development` option plus two env vars, so these
 * tests drive it directly: each clears `NODE_ENV`/`WEFT_DEV_WARNINGS` to a known
 * baseline and restores them afterward, so a development shell running the suite
 * cannot mask the production-default (no-warn) path.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { CompressedStorage } from '../../storage/compressed-storage.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { resolveEngineStorage } from './construction.ts';

const FALLBACK_PATTERN = /no `storage` configured.*MemoryStorage/s;

const savedNodeEnv = Bun.env['NODE_ENV'];
const savedDevWarnings = Bun.env['WEFT_DEV_WARNINGS'];

function restore(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete Bun.env[key];
  } else {
    Bun.env[key] = value;
  }
}

describe('MemoryStorage fallback warning', () => {
  beforeEach(() => {
    // Known production-like baseline: neither dev signal set.
    delete Bun.env['NODE_ENV'];
    delete Bun.env['WEFT_DEV_WARNINGS'];
  });

  afterEach(() => {
    restore('NODE_ENV', savedNodeEnv);
    restore('WEFT_DEV_WARNINGS', savedDevWarnings);
  });

  it('warns when WEFT_DEV_WARNINGS=1 and no storage is configured', () => {
    Bun.env['WEFT_DEV_WARNINGS'] = '1';
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

  it('warns via the explicit development:true option', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      resolveEngineStorage({ development: true });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatch(FALLBACK_PATTERN);
    } finally {
      warn.mockRestore();
    }
  });

  it('stays silent in the production default (no dev signal, no storage)', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const storage = resolveEngineStorage();
      expect(storage).toBeInstanceOf(MemoryStorage);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('stays silent when storage is explicitly provided, even in development', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const provided = new MemoryStorage();
      const storage = resolveEngineStorage({ storage: provided, development: true });
      expect(storage).toBe(provided);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('warns and still wraps in CompressedStorage when compression is set without storage', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const storage = resolveEngineStorage({ development: true, compression: {} });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(storage).toBeInstanceOf(CompressedStorage);
    } finally {
      warn.mockRestore();
    }
  });
});

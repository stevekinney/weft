import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../storage/interface.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { encode } from '../codec.ts';
import { loadStoredStreamChunks } from './stream-chunk-loading.ts';

describe('loadStoredStreamChunks', () => {
  it('loads decoded stream chunks in storage order', async () => {
    const storage = new MemoryStorage();
    await storage.put(KEYS.streamChunk('workflow-1', 'tokens', 0), encode({ token: 'alpha' }));
    await storage.put(KEYS.streamChunk('workflow-1', 'tokens', 1), encode({ token: 'beta' }));

    const chunks = await loadStoredStreamChunks(storage, 'workflow-1', 'tokens');

    expect(chunks).toEqual([
      { sequence: 0, value: { token: 'alpha' } },
      { sequence: 1, value: { token: 'beta' } },
    ]);
  });

  it('loads only chunks after the requested sequence cursor', async () => {
    const storage = new MemoryStorage();
    await storage.put(KEYS.streamChunk('workflow-1', 'tokens', 0), encode('zero'));
    await storage.put(KEYS.streamChunk('workflow-1', 'tokens', 1), encode('one'));
    await storage.put(KEYS.streamChunk('workflow-1', 'tokens', 2), encode('two'));

    const chunks = await loadStoredStreamChunks(storage, 'workflow-1', 'tokens', { after: 1 });

    expect(chunks).toEqual([{ sequence: 2, value: 'two' }]);
  });

  it('ignores malformed stream chunk suffixes', async () => {
    const storage = new MemoryStorage();
    const prefix = KEYS.streamChunkPrefix('workflow-1', 'tokens');
    await storage.put(KEYS.streamChunk('workflow-1', 'tokens', 0), encode('valid'));
    await storage.put(`${prefix}not-a-number`, encode('invalid'));
    await storage.put(`${prefix}0000000001-trailing-text`, encode('partially-numeric'));

    const chunks = await loadStoredStreamChunks(storage, 'workflow-1', 'tokens');

    expect(chunks).toEqual([{ sequence: 0, value: 'valid' }]);
  });

  it('fails malformed stream chunk payloads without exposing codec internals', async () => {
    const storage = new MemoryStorage();
    await storage.put(KEYS.streamChunk('workflow-1', 'tokens', 0), new Uint8Array([0xc1]));

    await expect(loadStoredStreamChunks(storage, 'workflow-1', 'tokens')).rejects.toThrow(
      'Invalid stored stream chunk payload',
    );
  });
});

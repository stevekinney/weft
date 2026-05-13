import { CompressedStorage } from 'weft/storage/compressed';
import { MemoryStorage } from 'weft/storage/memory';

// @ts-expect-error Agent-specific compression options are intentionally not public API.
declare const _removedAgentCompressionOptions: import('weft/storage/compressed').AgentCompressionOptions;
void _removedAgentCompressionOptions;

const _storage = new CompressedStorage(new MemoryStorage(), {
  algorithm: 'gzip',
  threshold: 1024,
});
void _storage;

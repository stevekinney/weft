import { KEYS, type Storage } from '../../storage/interface.ts';
import { decode } from '../codec.ts';
import type { StoredStreamChunk } from '../context.ts';

const STREAM_CHUNK_SEQUENCE_PATTERN = /^\d+$/;

function parseStreamChunkSequence(sequenceText: string): number | undefined {
  if (!STREAM_CHUNK_SEQUENCE_PATTERN.test(sequenceText)) return undefined;
  const sequence = Number.parseInt(sequenceText, 10);
  return Number.isSafeInteger(sequence) ? sequence : undefined;
}

export async function loadStoredStreamChunks(
  storage: Storage,
  workflowId: string,
  key: string,
  options?: { after?: number },
): Promise<StoredStreamChunk[]> {
  const after = options?.after;
  const prefix = KEYS.streamChunkPrefix(workflowId, key);
  const chunks: StoredStreamChunk[] = [];
  const scanOptions =
    after !== undefined && after >= 0
      ? { gt: KEYS.streamChunk(workflowId, key, after) }
      : undefined;

  for await (const [storageKey, chunkBytes] of storage.scan(prefix, scanOptions)) {
    const sequenceText = storageKey.slice(prefix.length);
    const sequence = parseStreamChunkSequence(sequenceText);
    if (sequence === undefined) continue;

    chunks.push({
      sequence,
      value: decode(chunkBytes),
    });
  }

  return chunks;
}

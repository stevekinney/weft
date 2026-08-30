import { KEYS, type Storage } from '../../storage/interface.ts';
import { decode, encode } from '../codec.ts';
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

export function encodeStoredStreamTailSequence(sequence: number): Uint8Array {
  return encode({ sequence });
}

function parseStoredStreamTailSequence(value: unknown): number | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  if (!('sequence' in value)) {
    return null;
  }

  const sequence = value.sequence;
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < -1) {
    return null;
  }

  return sequence;
}

export async function loadStoredStreamTailSequence(
  storage: Storage,
  workflowId: string,
  key: string,
): Promise<number | null> {
  const bytes = await storage.get(KEYS.streamTail(workflowId, key));
  if (bytes === null) return null;

  try {
    return parseStoredStreamTailSequence(decode(bytes));
  } catch {
    return null;
  }
}

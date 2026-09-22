import { MemoryStorage } from '../../storage/memory.ts';
import { principalFromApiKey } from '../principal.ts';

export function encode(value: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(value));
}

export function decode(value: Uint8Array | null): string | null {
  return value === null ? null : new TextDecoder().decode(value);
}

export class TrackingScanStorage extends MemoryStorage {
  entriesPulled = 0;

  override scan(prefix: string): AsyncIterable<[string, Uint8Array]> {
    const entries: Array<[string, Uint8Array]> = [
      [`${prefix}a`, encode('a')],
      [`${prefix}b`, encode('b')],
      [`${prefix}c`, encode('c')],
    ];
    let index = 0;

    return {
      [Symbol.asyncIterator]: (): AsyncIterator<[string, Uint8Array]> => ({
        next: async (): Promise<IteratorResult<[string, Uint8Array]>> => {
          const entry = entries[index];
          if (entry === undefined) {
            return { done: true, value: undefined };
          }

          index += 1;
          this.entriesPulled += 1;
          return { done: false, value: entry };
        },
        return: async (): Promise<IteratorResult<[string, Uint8Array]>> => ({
          done: true,
          value: undefined,
        }),
      }),
    };
  }
}

export class ThrowingScanStorage extends MemoryStorage {
  override scan(): AsyncIterable<[string, Uint8Array]> {
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<[string, Uint8Array]> => ({
        next: async (): Promise<IteratorResult<[string, Uint8Array]>> => {
          throw new Error('scan failed');
        },
      }),
    };
  }
}

export class DistinctCapabilityStorage extends MemoryStorage {
  override capabilities(): ReturnType<MemoryStorage['capabilities']> {
    return {
      persistence: 'remote',
      readAfterWrite: 'eventual',
      scanConsistency: 'best-effort',
      atomicBatch: false,
      conditionalBatch: false,
      boundedRangeDelete: false,
    };
  }
}

export function request(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init);
}

export function writeOnlyStorageOptions() {
  return {
    authContext: {
      method: 'api-key' as const,
      principal: principalFromApiKey({
        subject: 'write-only-caller',
        scopes: ['storage:write'],
      }),
    },
  };
}

export function readWriteStorageOptions() {
  return {
    authContext: {
      method: 'api-key' as const,
      principal: principalFromApiKey({
        subject: 'read-write-caller',
        scopes: ['storage:read', 'storage:write'],
      }),
    },
  };
}

export function adminOnlyStorageOptions() {
  return {
    authContext: {
      method: 'api-key' as const,
      principal: principalFromApiKey({
        subject: 'admin-only-caller',
        scopes: ['storage:admin'],
      }),
    },
  };
}

export function adminStorageOptions() {
  return {
    authContext: {
      method: 'api-key' as const,
      principal: principalFromApiKey({
        subject: 'admin-caller',
        scopes: ['storage:read', 'storage:write', 'storage:admin'],
      }),
    },
  };
}

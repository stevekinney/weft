import { expect } from 'bun:test';

import type { Storage } from './interface.ts';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Encode a string as bytes for storage values. */
export function bytes(value: string): Uint8Array {
  return textEncoder.encode(value);
}

/** Decode storage bytes back into a string. */
export function decodeText(value: Uint8Array): string {
  return textDecoder.decode(value);
}

/** Drain an async iterable into an array, preserving order. */
export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) {
    values.push(value);
  }
  return values;
}

/** Assert that a storage adapter reports a valid capability shape. */
export function assertCapabilitiesShape(storage: Storage): void {
  const capabilities = storage.capabilities();
  expect(['ephemeral', 'local', 'remote']).toContain(capabilities.persistence ?? '');
  expect(['linearizable', 'session', 'eventual']).toContain(capabilities.readAfterWrite);
  expect(['snapshot', 'best-effort']).toContain(capabilities.scanConsistency);
  expect(typeof capabilities.atomicBatch).toBe('boolean');
  expect(typeof capabilities.conditionalBatch).toBe('boolean');
  expect(typeof capabilities.boundedRangeDelete).toBe('boolean');
}

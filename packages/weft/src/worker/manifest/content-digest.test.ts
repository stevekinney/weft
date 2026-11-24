import { describe, expect, it } from 'bun:test';

import { CONTENT_DIGEST_ALGORITHM, sha256Hex } from './content-digest.ts';

describe('sha256Hex', () => {
  it('tags the digest with the sha256 algorithm prefix', async () => {
    const digest = await sha256Hex('hello');
    expect(digest.startsWith(`${CONTENT_DIGEST_ALGORITHM}:`)).toBe(true);
  });

  it('produces a 64-character lowercase hex digest after the tag', async () => {
    const digest = await sha256Hex('hello');
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('is deterministic for the same input', async () => {
    expect(await sha256Hex('same input')).toBe(await sha256Hex('same input'));
  });

  it('produces different digests for different inputs', async () => {
    expect(await sha256Hex('input a')).not.toBe(await sha256Hex('input b'));
  });

  it('matches the known SHA-256 digest of an empty string', async () => {
    expect(await sha256Hex('')).toBe(
      'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('sha256Hex without SubtleCrypto', () => {
  // `crypto.subtle` exists only in secure contexts, and a console served over
  // plain HTTP computes its activity-hash comparison without it.
  async function withoutSubtle<T>(run: () => Promise<T>): Promise<T> {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: { getRandomValues: crypto.getRandomValues.bind(crypto) },
    });
    try {
      return await run();
    } finally {
      if (original === undefined) Reflect.deleteProperty(globalThis, 'crypto');
      else Object.defineProperty(globalThis, 'crypto', original);
    }
  }

  it('produces the known SHA-256 vector when crypto.subtle is undefined', async () => {
    const digest = await withoutSubtle(async () => {
      expect(globalThis.crypto.subtle).toBeUndefined();
      return sha256Hex('abc');
    });
    expect(digest).toBe('sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('matches the SubtleCrypto digest for non-ASCII input', async () => {
    const input = '{"name":"café ☕","emoji":"\u{1F600}"}';
    const withSubtle = await sha256Hex(input);
    expect(await withoutSubtle(() => sha256Hex(input))).toBe(withSubtle);
  });
});

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

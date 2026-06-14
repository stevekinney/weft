import { describe, expect, it } from 'bun:test';

import { readOptionalRestJsonBody, readRestBodyBounded } from './rest-body.ts';

describe('readRestBodyBounded', () => {
  it('preserves the payload-too-large fault when stream cancellation rejects', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
      },
      cancel() {
        throw new Error('cancel failed');
      },
    });

    await expect(
      readRestBodyBounded(
        new Request('http://localhost/body', {
          method: 'POST',
          body: stream,
        }),
        { maxBodyBytes: 1 },
      ),
    ).rejects.toMatchObject({
      code: 'PayloadTooLarge',
      message: 'Payload Too Large',
      data: { maxBytes: 1 },
    });
  });
});

describe('readOptionalRestJsonBody', () => {
  it('returns undefined for an empty JSON body', async () => {
    await expect(
      readOptionalRestJsonBody(
        new Request('http://localhost/body', {
          method: 'POST',
          body: '  ',
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it('parses a non-empty JSON body', async () => {
    await expect(
      readOptionalRestJsonBody(
        new Request('http://localhost/body', {
          method: 'POST',
          body: '{"ok":true}',
        }),
      ),
    ).resolves.toEqual({ ok: true });
  });
});

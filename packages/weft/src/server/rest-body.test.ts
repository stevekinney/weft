import { describe, expect, it } from 'bun:test';

import { rejectionOf } from '../testing/promise-outcome.test-support.ts';
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

    expect(
      await rejectionOf(
        readRestBodyBounded(
          new Request('http://localhost/body', {
            method: 'POST',
            body: stream,
          }),
          { maxBodyBytes: 1 },
        ),
      ),
    ).toMatchObject({
      code: 'PayloadTooLarge',
      message: 'Payload Too Large',
      data: { maxBytes: 1 },
    });
  });
});

describe('readOptionalRestJsonBody', () => {
  it('returns undefined for an empty JSON body', async () => {
    expect(
      await readOptionalRestJsonBody(
        new Request('http://localhost/body', {
          method: 'POST',
          body: '  ',
        }),
      ),
    ).toBeUndefined();
  });

  it('parses a non-empty JSON body', async () => {
    expect(
      await readOptionalRestJsonBody(
        new Request('http://localhost/body', {
          method: 'POST',
          body: '{"ok":true}',
        }),
      ),
    ).toEqual({ ok: true });
  });
});

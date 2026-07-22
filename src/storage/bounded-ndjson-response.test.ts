import { describe, expect, it } from 'bun:test';

import { readBoundedNdjsonResponse } from './bounded-ndjson-response.ts';

const textEncoder = new TextEncoder();

describe('readBoundedNdjsonResponse', () => {
  it('accepts a response exactly at the byte limit and rejects the next byte', async () => {
    const boundaryResponse = new Response(textEncoder.encode('one\ntwo'));

    await expect(
      Array.fromAsync(
        readBoundedNdjsonResponse(boundaryResponse, {
          maximumBytes: 7,
          sizeLimitError: () => new Error('response too large'),
        }),
      ),
    ).resolves.toEqual(['one', 'two']);

    const oversizedResponse = new Response(textEncoder.encode('one\ntwo!'));
    await expect(
      Array.fromAsync(
        readBoundedNdjsonResponse(oversizedResponse, {
          maximumBytes: 7,
          sizeLimitError: () => new Error('response too large'),
        }),
      ),
    ).rejects.toThrow('response too large');
  });

  it('decodes partial lines and split multibyte characters across chunks', async () => {
    const encoded = textEncoder.encode('first\nsecond-😀\nthird');
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoded.subarray(0, 9));
          controller.enqueue(encoded.subarray(9, 15));
          controller.enqueue(encoded.subarray(15));
          controller.close();
        },
      }),
    );

    await expect(
      Array.fromAsync(
        readBoundedNdjsonResponse(response, {
          maximumBytes: encoded.byteLength,
          sizeLimitError: () => new Error('response too large'),
        }),
      ),
    ).resolves.toEqual(['first', 'second-😀', 'third']);
  });

  it('cancels and releases the reader when iteration stops early', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(textEncoder.encode('first\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const iterator = readBoundedNdjsonResponse(new Response(stream), {
      maximumBytes: 100,
      sizeLimitError: () => new Error('response too large'),
    })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({ done: false, value: 'first' });
    await iterator.return?.();

    expect(cancelled).toBe(true);
    expect(stream.locked).toBe(false);
  });

  it('releases the reader after consuming the complete response', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(textEncoder.encode('only'));
        controller.close();
      },
    });

    await Array.fromAsync(
      readBoundedNdjsonResponse(new Response(stream), {
        maximumBytes: 100,
        sizeLimitError: () => new Error('response too large'),
      }),
    );

    expect(stream.locked).toBe(false);
  });
});

import type { StoredStreamChunk } from '../../core/context.ts';

const textEncoder = new TextEncoder();

/** Format a single Server-Sent Events message. */
function formatSSE(event: { id?: string; event?: string; data: string }): string {
  const lines: string[] = [];
  if (event.id !== undefined) lines.push(`id: ${event.id}`);
  if (event.event !== undefined) lines.push(`event: ${event.event}`);
  const dataLines = event.data.split('\n');
  for (const line of dataLines) {
    lines.push(`data: ${line}`);
  }
  lines.push('');
  return lines.join('\n') + '\n';
}

/**
 * Wrap a list of stored stream chunks as a Server-Sent Events stream. Each
 * chunk gets emitted as a `token` event keyed by `chunk.sequence`; chunks
 * whose mapped text is `null` are skipped. After the chunks, a single
 * `done` event with empty data is emitted and the controller closes.
 *
 * Used by REST `shapeSuccess` for the streaming routes (`streamSSE`,
 * `getStreamChunks` when negotiated to `text/event-stream`).
 */
export function createStoredChunkSSEStream(
  chunks: ReadonlyArray<StoredStreamChunk>,
  mapChunkToText: (chunk: StoredStreamChunk) => string | null,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        const text = mapChunkToText(chunk);
        if (text === null) {
          continue;
        }

        controller.enqueue(
          textEncoder.encode(
            formatSSE({
              id: String(chunk.sequence),
              event: 'token',
              data: text,
            }),
          ),
        );
      }

      controller.enqueue(
        textEncoder.encode(
          formatSSE({
            event: 'done',
            data: '',
          }),
        ),
      );
      controller.close();
    },
  });
}

/** Standard headers for an SSE response. */
export const SSE_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
};

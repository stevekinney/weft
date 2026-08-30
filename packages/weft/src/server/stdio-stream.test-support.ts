/**
 * Byte-stream plumbing shared by the stdio JSON-RPC session tests.
 *
 * `runStdioSession` is parameterized over `ReadableStream`/`WritableStream`
 * so it can be driven without a subprocess. These helpers build a readable
 * from pre-framed lines and a writable that re-splits written bytes into
 * newline-delimited lines for assertions.
 */

/** Build a ReadableStream<Uint8Array> from a list of pre-framed strings. */
export function readableFromLines(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    },
  });
}

/** Collect every chunk written to a WritableStream<Uint8Array> as newline-split lines. */
export function collectingWritable(): {
  stream: WritableStream<Uint8Array>;
  lines(): string[];
} {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  const complete: string[] = [];
  const stream = new WritableStream<Uint8Array>({
    write(chunk) {
      buffer += decoder.decode(chunk, { stream: true });
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        complete.push(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf('\n');
      }
    },
    close() {
      if (buffer.length > 0) complete.push(buffer);
    },
  });
  return {
    stream,
    lines() {
      return [...complete];
    },
  };
}

export type BoundedNdjsonResponseOptions = {
  readonly maximumBytes: number;
  readonly sizeLimitError: () => Error;
};

export async function* readBoundedNdjsonResponse(
  response: Response,
  options: BoundedNdjsonResponseOptions,
): AsyncIterable<string> {
  if (response.body === null) return;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bufferedText = '';
  let bytesRead = 0;
  let reachedEndOfStream = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        reachedEndOfStream = true;
        break;
      }

      bytesRead += value.byteLength;
      if (bytesRead > options.maximumBytes) {
        throw options.sizeLimitError();
      }

      bufferedText += decoder.decode(value, { stream: true });
      const lines = bufferedText.split('\n');
      bufferedText = lines.pop() ?? '';

      for (const line of lines) {
        yield line;
      }
    }

    bufferedText += decoder.decode();
    if (bufferedText.length > 0) {
      yield bufferedText;
    }
  } finally {
    if (!reachedEndOfStream) {
      try {
        await reader.cancel();
      } catch {
        // Preserve the failure or consumer return that triggered cleanup.
      }
    }
    reader.releaseLock();
  }
}

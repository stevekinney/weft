import type { OperationFault } from './operation-fault.ts';

/** The default limit on a REST request body: 1 MiB. */
export const DEFAULT_REST_MAX_BODY_BYTES = 1 * 1024 * 1024;

const CONTENT_LENGTH_PATTERN = /^(0|[1-9]\d*)$/;

/** Options for reading a REST request body. */
export type RestBodyReadOptions = {
  /** The largest body to accept, in bytes. */
  readonly maxBodyBytes?: number;
};

export function payloadTooLargeFault(maxBytes: number): OperationFault {
  return {
    code: 'PayloadTooLarge',
    message: 'Payload Too Large',
    data: { maxBytes },
  };
}

function invalidContentLengthFault(): OperationFault {
  return {
    code: 'InvalidParams',
    message: 'Invalid Content-Length header',
    data: { issues: [] },
  };
}

function resolveMaxBodyBytes(options: RestBodyReadOptions | undefined): number {
  const maxBytes = options?.maxBodyBytes ?? DEFAULT_REST_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error('REST body size limit must be a non-negative safe integer');
  }
  return maxBytes;
}

function assertDeclaredContentLengthWithinLimit(request: Request, maxBytes: number): void {
  const header = request.headers.get('content-length');
  if (header === null) return;
  if (!CONTENT_LENGTH_PATTERN.test(header)) {
    throw invalidContentLengthFault();
  }
  const declared = Number(header);
  if (!Number.isSafeInteger(declared) || declared < 0) {
    throw invalidContentLengthFault();
  }
  if (declared > maxBytes) {
    throw payloadTooLargeFault(maxBytes);
  }
}

async function cancelReaderAfterPayloadOverflow(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // The payload limit has already been crossed. Preserve the 413 fault even
    // when an underlying runtime or client body rejects cancellation.
  }
}

/** Reads a request body, refusing one larger than the limit with a `PayloadTooLarge` fault. */
export async function readRestBodyBounded(
  request: Request,
  options?: RestBodyReadOptions,
): Promise<Uint8Array> {
  const maxBytes = resolveMaxBodyBytes(options);
  assertDeclaredContentLengthWithinLimit(request, maxBytes);

  const body = request.body;
  if (body === null) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await cancelReaderAfterPayloadOverflow(reader);
        throw payloadTooLargeFault(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Reads a request body within the size limit and decodes it as UTF-8. */
export async function readRestTextBody(
  request: Request,
  options?: RestBodyReadOptions,
): Promise<string> {
  return new TextDecoder('utf-8').decode(await readRestBodyBounded(request, options));
}

/** Reads a request body within the size limit and parses it as JSON. */
export async function readRestJsonBody(
  request: Request,
  options?: RestBodyReadOptions,
): Promise<unknown> {
  return JSON.parse(await readRestTextBody(request, options)) as unknown;
}

/** Reads a JSON request body within the size limit, or `undefined` when the body is empty. */
export async function readOptionalRestJsonBody(
  request: Request,
  options?: RestBodyReadOptions,
): Promise<unknown> {
  const text = await readRestTextBody(request, options);
  return text.trim() === '' ? undefined : (JSON.parse(text) as unknown);
}

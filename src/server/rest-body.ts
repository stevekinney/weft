import type { OperationFault } from './operation-fault.ts';

export const DEFAULT_REST_MAX_BODY_BYTES = 1 * 1024 * 1024;

const CONTENT_LENGTH_PATTERN = /^(0|[1-9]\d*)$/;

export type RestBodyReadOptions = {
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
        await reader.cancel();
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

export async function readRestTextBody(
  request: Request,
  options?: RestBodyReadOptions,
): Promise<string> {
  return new TextDecoder('utf-8').decode(await readRestBodyBounded(request, options));
}

export async function readRestJsonBody(
  request: Request,
  options?: RestBodyReadOptions,
): Promise<unknown> {
  return JSON.parse(await readRestTextBody(request, options)) as unknown;
}

export async function readOptionalRestJsonBody(
  request: Request,
  options?: RestBodyReadOptions,
): Promise<unknown> {
  const text = await readRestTextBody(request, options);
  return text.trim() === '' ? undefined : (JSON.parse(text) as unknown);
}

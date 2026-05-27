import { z } from 'zod';

import type { StoredStreamChunk } from '../../core/context.ts';
import type { Engine } from '../../core/engine.ts';
import { FAULT_CODE_TO_HTTP_STATUS, type OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { parseOptionalSequenceCursor } from '../sequence-cursor.ts';
import { invalidParamsFault, jsonErrorResponse } from './operation-helpers.ts';
import { createStoredChunkSSEStream, SSE_RESPONSE_HEADERS } from './sse-stream.ts';

// `after` is permissive at the schema boundary so REST and JSON-RPC clients
// share one validation path. extractInput passes through the raw query
// string; invoke runs `parseOptionalSequenceCursor` so both transports
// receive identical "Invalid after query parameter" messages (and reject
// the same edge cases — < -1, hex, scientific notation).
const getStreamChunksInput = z.object({
  workflowId: z.string().min(1),
  key: z.string().min(1),
  after: z.unknown().optional(),
});

export type GetStreamChunksInput = z.infer<typeof getStreamChunksInput>;
export type GetStreamChunksOutput = { chunks: StoredStreamChunk[] };

export const getStreamChunksOperation = defineOperation<
  GetStreamChunksInput,
  GetStreamChunksOutput
>({
  name: 'weft.workflows.streams.chunks',
  mcpExposable: false,
  summary: 'Read stored stream chunks for a workflow stream key',
  destructive: false,
  tags: ['Streams'],
  inputSchema: getStreamChunksInput,
  outputSchema: z.object({ chunks: z.array(z.unknown()) }) as z.ZodType<GetStreamChunksOutput>,
  access: { kind: 'public' },
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<GetStreamChunksOutput> => {
    const e = engine as Engine;

    // REST passes the raw query string; JSON-RPC may pass an already-parsed
    // number. Either way, run the shared validator so both transports hit
    // the same "Invalid after query parameter" error path.
    let after: number | undefined;
    if (input.after !== undefined) {
      const rawCursor =
        typeof input.after === 'string'
          ? input.after
          : typeof input.after === 'number'
            ? String(input.after)
            : '';
      const parsed = parseOptionalSequenceCursor(rawCursor, 'after query parameter');
      if (parsed.error !== undefined) {
        throw invalidParamsFault(parsed.error);
      }
      after = parsed.value;
    }

    // Engine errors bubble — `executeOperation` wraps unhandled throws as a
    // sanitized `{ code: 'EngineFailure', message: 'internal error' }` fault
    // so raw engine messages (which may contain SQL, file paths, etc.) never
    // reach the wire. `shapeFault` maps that to a masked "Internal server
    // error" 500.
    const chunks =
      after !== undefined
        ? await e.getStreamChunks(input.workflowId, input.key, { after })
        : await e.getStreamChunks(input.workflowId, input.key);
    return { chunks };
  },
});

function shapeGetStreamChunksFault(fault: OperationFault): Response {
  if (fault.code === 'InvalidParams') {
    return jsonErrorResponse(fault.message, 400);
  }
  if (fault.code === 'EngineFailure') {
    // Mask engine errors to a generic 500 so raw engine messages never
    // reach clients.
    return jsonErrorResponse('Internal server error', 500);
  }
  return jsonErrorResponse(fault.message, FAULT_CODE_TO_HTTP_STATUS[fault.code]);
}

/**
 * Negotiate JSON vs SSE based on `Accept`. Prefer SSE when
 * `text/event-stream` is anywhere in `Accept`; otherwise return
 * `{ chunks }` as JSON. Cross-transport callers (JSON-RPC) always see JSON.
 */
function shapeGetStreamChunksSuccess(output: GetStreamChunksOutput, request: Request): Response {
  const accept = request.headers.get('Accept') ?? '';
  if (accept.includes('text/event-stream')) {
    return new Response(
      createStoredChunkSSEStream(output.chunks, (chunk) =>
        JSON.stringify({ sequence: chunk.sequence, value: chunk.value }),
      ),
      { status: 200, headers: SSE_RESPONSE_HEADERS },
    );
  }
  return new Response(JSON.stringify(output), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const getStreamChunksRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/workflows/:id/streams/:key',
  pathParamNames: ['id', 'key'],
  operationName: 'weft.workflows.streams.chunks',
  inputSources: {
    workflowId: { kind: 'path', pathParam: 'id' },
    key: { kind: 'path', pathParam: 'key' },
    after: { kind: 'query', queryParam: 'after' },
  },
  extractInput: async (request, pathParams) => {
    // Pass the raw `after` query string through; `invoke` parses and
    // validates it so REST and JSON-RPC share one cross-transport contract.
    const rawAfter = new URL(request.url).searchParams.get('after');
    return {
      workflowId: pathParams['id'] ?? '',
      key: pathParams['key'] ?? '',
      ...(rawAfter !== null ? { after: rawAfter } : {}),
    };
  },
  success: { kind: 'streaming', mediaType: 'text/event-stream' },
  shapeSuccess: shapeGetStreamChunksSuccess,
  shapeFault: shapeGetStreamChunksFault,
};

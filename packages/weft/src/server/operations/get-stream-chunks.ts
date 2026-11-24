import { z } from 'zod';

import { defineOperation } from "../../embedded/backchannel/src/index.ts";
import {
  type UnknownRestBinding,
  createStoredChunkSSEStream,
  invalidParamsFault,
  parseOptionalSequenceCursor,
  SSE_RESPONSE_HEADERS,
} from "../../embedded/backchannel/src/internals.ts";
import type { StoredStreamChunk } from '../../core/context.ts';
import { assertOperationEngineMethods } from './operation-helpers.ts';

// `after` is permissive at the schema boundary so REST and JSON-RPC clients
// share one validation path. extractInput passes through the raw query
// string; invoke runs `parseOptionalSequenceCursor` so both transports
// receive identical "Invalid after query parameter" messages (and reject
// the same edge cases — < -1, hex, scientific notation).
const getStreamChunksInput = z.object({
  workflowId: z.string().min(1).describe('Id of the workflow that owns the stream.'),
  key: z.string().min(1).describe('Stream key whose stored chunks are read.'),
  after: z
    .unknown()
    .optional()
    .describe(
      'Return only chunks after this sequence number (-1 or greater); omit it to read from the start.',
    ),
});

export type GetStreamChunksInput = z.infer<typeof getStreamChunksInput>;
export type GetStreamChunksOutput = { chunks: StoredStreamChunk[] };

export const getStreamChunksOperation = defineOperation({
  name: 'weft.workflows.streams.chunks',
  mcpExposable: false,
  summary: 'Read stored stream chunks for a workflow stream key',
  description:
    'Read the stored chunks a workflow wrote to one named stream, in order, ' +
    'optionally only those after a given sequence number. Read-only. Use ' +
    '`weft.workflows.streams.sse` to follow the token stream live.',
  destructive: false,
  tags: ['Streams'],
  inputSchema: getStreamChunksInput,
  outputSchema: z.object({ chunks: z.array(z.unknown()) }),
  access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['streams:read'] } },
  discoverable: true,
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, host: engine }): Promise<GetStreamChunksOutput> => {
    assertOperationEngineMethods(engine, ['getStreamChunks']);
    const e = engine;

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
};

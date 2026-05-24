import { z } from 'zod';

import type { StoredStreamChunk } from '../../core/context.ts';
import type { Engine } from '../../core/engine.ts';
import { FAULT_CODE_TO_HTTP_STATUS, type OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { parseOptionalSequenceCursor } from '../sequence-cursor.ts';
import { invalidParamsFault, jsonErrorResponse } from './operation-helpers.ts';
import { createStoredChunkSSEStream, SSE_RESPONSE_HEADERS } from './sse-stream.ts';

const TOKENS_STREAM_KEY = 'tokens';

// `after` is permissive at the schema boundary so REST and JSON-RPC clients
// share one validation path. extractInput passes through the raw header
// string; invoke parses it AFTER the 404 workflow-existence check, so
// workflow-not-found takes precedence over a bad cursor.
const streamWorkflowSseInput = z.object({
  workflowId: z.string().min(1),
  after: z.unknown().optional(),
});

export type StreamWorkflowSseInput = z.infer<typeof streamWorkflowSseInput>;
export type StreamWorkflowSseOutput = { chunks: StoredStreamChunk[] };

export const streamWorkflowSseOperation = defineOperation<
  StreamWorkflowSseInput,
  StreamWorkflowSseOutput
>({
  name: 'weft.workflows.streams.sse',
  mcpExposable: false,
  kind: 'stream',
  summary: 'Stream workflow tokens as Server-Sent Events',
  tags: ['Streams'],
  inputSchema: streamWorkflowSseInput,
  outputSchema: z.object({ chunks: z.array(z.unknown()) }) as z.ZodType<StreamWorkflowSseOutput>,
  eventSchema: z.object({ sequence: z.number(), value: z.unknown() }),
  access: { kind: 'public' },
  producibleFaults: ['NotFound'],
  // SSE is a REST-shaped delivery format; JSON-RPC clients receive the
  // canonical `{ chunks }` envelope from the same operation. Keeping all
  // four transports lets WebSocket/stdio callers consume token replays
  // without needing a separate operation.
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<StreamWorkflowSseOutput> => {
    const e = engine as Engine;

    // 404 wins precedence over a bad cursor: check workflow existence
    // before parsing `Last-Event-ID`.
    const state = await e.get(input.workflowId);
    if (state === null) {
      const message = `Workflow "${input.workflowId}" not found`;
      const fault: OperationFault = {
        code: 'NotFound',
        message,
        data: { resource: 'workflow', identifier: input.workflowId },
      };
      throw fault;
    }

    // REST passes the raw `Last-Event-ID` header string; JSON-RPC may pass an
    // already-parsed number. Either way, run the shared validator so both
    // transports hit the same "Invalid Last-Event-ID header" error path.
    let after: number | undefined;
    if (input.after !== undefined) {
      const rawCursor =
        typeof input.after === 'string'
          ? input.after
          : typeof input.after === 'number'
            ? String(input.after)
            : '';
      const parsed = parseOptionalSequenceCursor(rawCursor, 'Last-Event-ID header');
      if (parsed.error !== undefined) {
        throw invalidParamsFault(parsed.error);
      }
      after = parsed.value;
    }

    // Engine errors bubble — `executeOperation` wraps unhandled throws as a
    // sanitized `EngineFailure` so raw engine messages never reach the wire.
    // `shapeFault` maps that to a masked "Internal server error" 500.
    const chunks =
      after !== undefined
        ? await e.getStreamChunks(input.workflowId, TOKENS_STREAM_KEY, { after })
        : await e.getStreamChunks(input.workflowId, TOKENS_STREAM_KEY);
    return { chunks };
  },
});

const ACCEPT_HEADER_MUST_INCLUDE_SSE = 'Accept header must include text/event-stream';

function shapeStreamWorkflowSseFault(fault: OperationFault): Response {
  if (fault.code === 'NotFound') {
    return jsonErrorResponse(fault.message, 404);
  }
  if (fault.code === 'InvalidParams') {
    // 406 is returned for the Accept-header mismatch
    // (a REST-only check). All other InvalidParams paths use 400.
    if (fault.message === ACCEPT_HEADER_MUST_INCLUDE_SSE) {
      return jsonErrorResponse(fault.message, 406);
    }
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
 * Map a stored token chunk to the SSE `data:` text. Strings pass through
 * verbatim; objects with a non-empty `token` string property emit that
 * string. Anything else is dropped.
 */
function mapTokenChunkToText(chunk: StoredStreamChunk): string | null {
  if (typeof chunk.value === 'string') {
    return chunk.value;
  }
  if (typeof chunk.value === 'object' && chunk.value !== null && 'token' in chunk.value) {
    const { token } = chunk.value as { token: unknown };
    if (typeof token === 'string' && token.length > 0) {
      return token;
    }
  }
  return null;
}

function shapeStreamWorkflowSseSuccess(output: StreamWorkflowSseOutput): Response {
  return new Response(createStoredChunkSSEStream(output.chunks, mapTokenChunkToText), {
    status: 200,
    headers: SSE_RESPONSE_HEADERS,
  });
}

export const streamWorkflowSseRestBinding: UnknownRestBinding = {
  method: 'GET',
  path: '/v1/workflows/:id/sse',
  pathParamNames: ['id'],
  operationName: 'weft.workflows.streams.sse',
  transportKind: 'sse',
  inputSources: {
    workflowId: { kind: 'path', pathParam: 'id' },
    after: { kind: 'header', headerName: 'Last-Event-ID' },
  },
  extractInput: async (request, pathParams) => {
    // 406: REST-only Accept negotiation. JSON-RPC clients never reach
    // this path, so the check stays in extractInput rather than `invoke`.
    const accept = request.headers.get('Accept') ?? '';
    if (!accept.includes('text/event-stream')) {
      throw invalidParamsFault(ACCEPT_HEADER_MUST_INCLUDE_SSE);
    }

    // Pass the raw `Last-Event-ID` header through; `invoke` parses and
    // validates it AFTER the workflow-existence check so 404 takes
    // precedence over a bad cursor.
    const rawLastEventId = request.headers.get('Last-Event-ID');
    return {
      workflowId: pathParams['id'] ?? '',
      ...(rawLastEventId !== null ? { after: rawLastEventId } : {}),
    };
  },
  success: { kind: 'streaming', mediaType: 'text/event-stream' },
  shapeSuccess: shapeStreamWorkflowSseSuccess,
  shapeFault: shapeStreamWorkflowSseFault,
};

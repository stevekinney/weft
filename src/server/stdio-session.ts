/**
 * Runtime JSON-RPC stdio session.
 *
 * `runStdioSession({ input, output, admission, registry, engine, feed, ... })`
 * drives the `weft rpc-stdio` CLI subcommand (Track 8 design decision
 * 19). It reads newline-delimited JSON frames from `input`, runs each
 * through the same `createJsonRpcWebSocketSession` session the WS
 * adapter uses, and writes responses to `output`.
 *
 * Admission is mandatory:
 *   - `{ kind: 'startup-token', token }` — the first frame must be a
 *     `weft.authenticate` call whose `params.token` matches. On match,
 *     the session principal is `stdio-local` with admin scopes. On
 *     mismatch, the session returns `exit 2` without starting.
 *   - `{ kind: 'allow-unauthenticated-local-admin' }` — session starts
 *     immediately with a `stdio-local` principal. The CLI flag that
 *     enables this reads "grants full engine access to any local
 *     process that can spawn this binary" in both the help text and
 *     the startup log.
 *   - `{ kind: 'require-one' }` — neither flag supplied → exit 2.
 *
 * The session is a thin wrapper over the WS session: the only real
 * difference is the transport (newline-delimited stdin/stdout instead
 * of a socket) and the admission gate. Subscribe / unsubscribe and all
 * the JSON-RPC semantics come from the shared session.
 */

import { splitNewlineDelimitedBuffer } from './json-rpc-framing.ts';
import { JSON_RPC_ERROR_CODES, JSON_RPC_VERSION, type JsonRpcId } from './json-rpc-protocol.ts';
import {
  createJsonRpcWebSocketSession,
  type JsonRpcWebSocketEmitter,
} from './json-rpc-websocket.ts';
import type { OperationRegistry } from './operation-catalog.ts';
import { principalFromStdioLocal, type Principal } from './principal.ts';
import type { WorkflowEventFeed } from './workflow-event-feed.ts';

export type StdioAdmission =
  | { readonly kind: 'require-one' }
  | { readonly kind: 'startup-token'; readonly token: string }
  | { readonly kind: 'allow-unauthenticated-local-admin' };

export type StdioSessionOptions = {
  readonly input: ReadableStream<Uint8Array>;
  readonly output: WritableStream<Uint8Array>;
  readonly admission: StdioAdmission;
  readonly registry: OperationRegistry;
  readonly engine: unknown;
  readonly feed: WorkflowEventFeed;
  readonly maxFrameBytes?: number;
  readonly maxSubscriptions?: number;
};

export type StdioSessionResult = {
  readonly exitCode: number;
  readonly reason?: string;
};

const AUTHENTICATE_METHOD = 'weft.authenticate';

export async function runStdioSession(options: StdioSessionOptions): Promise<StdioSessionResult> {
  if (options.admission.kind === 'require-one') {
    return {
      exitCode: 2,
      reason:
        'stdio session admission required: pass --startup-token <hex> or --allow-unauthenticated-local-admin',
    };
  }

  const writer = options.output.getWriter();
  const encoder = new TextEncoder();

  async function writeFrame(message: Record<string, unknown>): Promise<void> {
    await writer.write(encoder.encode(JSON.stringify(message) + '\n'));
  }

  const emitter: JsonRpcWebSocketEmitter = {
    send(message: string): void {
      void writer.write(encoder.encode(message + '\n'));
    },
  };

  const reader = options.input.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  // For startup-token: the first frame MUST be weft.authenticate with
  // the matching token. Everything else is rejected with exit 2.
  if (options.admission.kind === 'startup-token') {
    const first = await readOneFrame(reader, decoder, buffer);
    if (first === null) {
      writer.releaseLock();
      return { exitCode: 2, reason: 'stdio session closed before authenticate frame' };
    }
    buffer = first.buffer;
    const frame = first.line;
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame);
    } catch {
      await writeFrame({
        jsonrpc: JSON_RPC_VERSION,
        error: { code: JSON_RPC_ERROR_CODES.PARSE_ERROR, message: 'Parse error' },
        id: null,
      });
      await writer.close();
      return { exitCode: 2, reason: 'first frame was not valid JSON' };
    }
    if (
      !isPlainObject(parsed) ||
      parsed['jsonrpc'] !== JSON_RPC_VERSION ||
      parsed['method'] !== AUTHENTICATE_METHOD
    ) {
      const id: JsonRpcId = isPlainObject(parsed) ? asId(parsed['id']) : null;
      await writeFrame({
        jsonrpc: JSON_RPC_VERSION,
        error: {
          code: JSON_RPC_ERROR_CODES.UNAUTHORIZED,
          message: 'first frame must be weft.authenticate',
          data: { weftCode: 'Unauthorized', httpStatus: 401 },
        },
        id,
      });
      await writer.close();
      return { exitCode: 2, reason: 'first frame was not weft.authenticate' };
    }
    const params = parsed['params'];
    const providedToken = isPlainObject(params) ? params['token'] : undefined;
    if (typeof providedToken !== 'string' || providedToken !== options.admission.token) {
      const id = asId(parsed['id']);
      await writeFrame({
        jsonrpc: JSON_RPC_VERSION,
        error: {
          code: JSON_RPC_ERROR_CODES.UNAUTHORIZED,
          message: 'startup token mismatch',
          data: { weftCode: 'Unauthorized', httpStatus: 401 },
        },
        id,
      });
      await writer.close();
      return { exitCode: 2, reason: 'startup token mismatch' };
    }
    // Success — acknowledge the authenticate call.
    const id = asId(parsed['id']);
    await writeFrame({ jsonrpc: JSON_RPC_VERSION, result: {}, id });
  }

  const principal: Principal = principalFromStdioLocal();
  const session = createJsonRpcWebSocketSession({
    registry: options.registry,
    engine: options.engine,
    principal,
    emitter,
    feed: options.feed,
    ...(options.maxFrameBytes !== undefined ? { maxFrameBytes: options.maxFrameBytes } : {}),
    ...(options.maxSubscriptions !== undefined
      ? { maxSubscriptions: options.maxSubscriptions }
      : {}),
  });

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      const framed = splitNewlineDelimitedBuffer(buffer, '');
      buffer = framed.buffer;
      for (const line of framed.lines) {
        await session.handleMessage(line);
      }
    }
  } finally {
    await session.close();
    try {
      await writer.close();
    } catch {
      // writer may already be closed by the time we get here.
    }
  }

  return { exitCode: 0 };
}

async function readOneFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  initialBuffer: string,
): Promise<{ line: string; buffer: string } | null> {
  let buffer = initialBuffer;
  while (true) {
    const framed = splitNewlineDelimitedBuffer(buffer, '');
    if (framed.lines.length > 0) {
      const [line, ...rest] = framed.lines;
      const remainder =
        rest.length > 0
          ? rest.join('\n') + (framed.buffer ? '\n' + framed.buffer : '')
          : framed.buffer;
      return { line: line!, buffer: remainder };
    }
    buffer = framed.buffer;
    const result = await reader.read();
    if (result.done) return null;
    buffer += decoder.decode(result.value, { stream: true });
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asId(value: unknown): JsonRpcId {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

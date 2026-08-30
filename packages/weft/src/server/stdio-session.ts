/**
 * Runtime JSON-RPC stdio session.
 *
 * `runStdioSession({ input, output, admission, registry, engine, feed, ... })`
 * drives the `weft rpc-stdio` CLI subcommand. It implements the stable
 * JSON-RPC stdio transport: reading newline-delimited JSON frames from
 * `input`, running each through the JSON-RPC dispatcher, and writing
 * responses to `output`.
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
import { isPlainObject } from './json-schema-utilities.ts';
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
const DEFAULT_MAX_FRAME_BYTES = 1_048_576;

type SessionIO = {
  readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly writeFrame: (message: Record<string, unknown>) => Promise<void>;
  readonly emitter: JsonRpcWebSocketEmitter;
  readonly drainWrites: () => Promise<void>;
};

type AdmissionOutcome =
  | { kind: 'ok'; remainder: string }
  | { kind: 'fail'; result: StdioSessionResult };

export async function runStdioSession(options: StdioSessionOptions): Promise<StdioSessionResult> {
  if (options.admission.kind === 'require-one') {
    return {
      exitCode: 2,
      reason:
        'stdio session admission required: pass --startup-token <hex> or --allow-unauthenticated-local-admin',
    };
  }

  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const io = createSessionIO(options.output);
  const reader = options.input.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  if (options.admission.kind === 'startup-token') {
    const outcome = await runStartupTokenAdmission(
      reader,
      decoder,
      buffer,
      maxFrameBytes,
      options.admission.token,
      io,
    );
    if (outcome.kind === 'fail') {
      await io.drainWrites();
      await closeWriterSilent(io.writer);
      return outcome.result;
    }
    buffer = outcome.remainder;
  }

  const principal: Principal = principalFromStdioLocal();
  const session = createJsonRpcWebSocketSession({
    registry: options.registry,
    engine: options.engine,
    principal,
    emitter: io.emitter,
    feed: options.feed,
    // Dispatch operations as `jsonRpcStdio`, not `jsonRpcWebSocket`,
    // so the transport-availability check in `executeOperation`
    // evaluates the right flag for this session. Operations
    // configured with `jsonRpcStdio: false` must be rejected on
    // stdio even if their WS flag is true, and vice versa.
    transport: 'jsonRpcStdio',
    ...(options.maxFrameBytes !== undefined ? { maxFrameBytes: options.maxFrameBytes } : {}),
    ...(options.maxSubscriptions !== undefined
      ? { maxSubscriptions: options.maxSubscriptions }
      : {}),
  });

  try {
    // Drain any complete frames already in the buffer before the next
    // read — without this, a client that pipelined the auth frame and
    // the first call frame in one chunk would see the call frame sit
    // in `buffer` until either another chunk arrives or EOF.
    buffer = await drainCompleteFramesFromBuffer(buffer, session);
    buffer = await runMainReadLoop(reader, decoder, buffer, maxFrameBytes, session, io);
  } finally {
    await session.close();
    await io.drainWrites();
    await closeWriterSilent(io.writer);
  }

  return { exitCode: 0 };
}

/**
 * Build the writer + ordered write-chain + emitter bundle. Every write
 * (admission frames, dispatcher results, subscription notifications)
 * goes through the same serialized chain so ordering is preserved and
 * `drainWrites()` before close waits for pending frames.
 */
function createSessionIO(output: WritableStream<Uint8Array>): SessionIO {
  const writer = output.getWriter();
  const encoder = new TextEncoder();
  let writeChain: Promise<void> = Promise.resolve();

  function enqueueWrite(text: string): Promise<void> {
    const next = writeChain.then(() => writer.write(encoder.encode(text)));
    writeChain = next.catch(() => {
      // Swallow here so the chain keeps advancing; callers that
      // specifically want to know a write failed can await the
      // returned promise directly.
    });
    return next;
  }

  return {
    writer,
    writeFrame: (message) => enqueueWrite(JSON.stringify(message) + '\n'),
    emitter: {
      send(message: string): void {
        // Fire-and-forget at the call site, but the write lands in the
        // serialized queue so ordering is preserved and the final
        // `drainWrites()` before `writer.close()` awaits every pending
        // frame.
        void enqueueWrite(message + '\n');
      },
    },
    drainWrites: async () => {
      try {
        await writeChain;
      } catch {
        // Already surfaced to the originating caller via the returned
        // promise from `enqueueWrite`.
      }
    },
  };
}

async function runStartupTokenAdmission(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  initialBuffer: string,
  maxFrameBytes: number,
  expectedToken: string,
  io: SessionIO,
): Promise<AdmissionOutcome> {
  const first = await readOneFrame(reader, decoder, initialBuffer, maxFrameBytes);
  if (first.kind === 'closed') {
    return {
      kind: 'fail',
      result: { exitCode: 2, reason: 'stdio session closed before authenticate frame' },
    };
  }
  if (first.kind === 'overflow') {
    await io.writeFrame({
      jsonrpc: JSON_RPC_VERSION,
      error: {
        code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
        message: 'authenticate frame exceeds maxFrameBytes',
        data: { weftCode: 'InvalidParams', httpStatus: 400 },
      },
      id: null,
    });
    return {
      kind: 'fail',
      result: { exitCode: 2, reason: 'authenticate frame exceeds maxFrameBytes' },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(first.line);
  } catch {
    await io.writeFrame({
      jsonrpc: JSON_RPC_VERSION,
      error: { code: JSON_RPC_ERROR_CODES.PARSE_ERROR, message: 'Parse error' },
      id: null,
    });
    return {
      kind: 'fail',
      result: { exitCode: 2, reason: 'first frame was not valid JSON' },
    };
  }

  const shapeFault = classifyAuthenticateShape(parsed);
  if (shapeFault) {
    await io.writeFrame(shapeFault.frame);
    return { kind: 'fail', result: shapeFault.result };
  }

  const asObject = parsed as Record<string, unknown>;
  const params = asObject['params'];
  const providedToken = isPlainObject(params) ? params['token'] : undefined;
  if (typeof providedToken !== 'string' || !constantTimeStringEqual(providedToken, expectedToken)) {
    const id = asId(asObject['id']);
    await io.writeFrame({
      jsonrpc: JSON_RPC_VERSION,
      error: {
        code: JSON_RPC_ERROR_CODES.UNAUTHORIZED,
        message: 'startup token mismatch',
        data: { weftCode: 'Unauthorized', httpStatus: 401 },
      },
      id,
    });
    return { kind: 'fail', result: { exitCode: 2, reason: 'startup token mismatch' } };
  }

  const id = asId(asObject['id']);
  await io.writeFrame({ jsonrpc: JSON_RPC_VERSION, result: {}, id });
  return { kind: 'ok', remainder: first.remainder };
}

function classifyAuthenticateShape(
  parsed: unknown,
): { frame: Record<string, unknown>; result: StdioSessionResult } | null {
  if (
    isPlainObject(parsed) &&
    parsed['jsonrpc'] === JSON_RPC_VERSION &&
    parsed['method'] === AUTHENTICATE_METHOD
  ) {
    return null;
  }
  const id: JsonRpcId = isPlainObject(parsed) ? asId(parsed['id']) : null;
  return {
    frame: {
      jsonrpc: JSON_RPC_VERSION,
      error: {
        code: JSON_RPC_ERROR_CODES.UNAUTHORIZED,
        message: 'first frame must be weft.authenticate',
        data: { weftCode: 'Unauthorized', httpStatus: 401 },
      },
      id,
    },
    result: { exitCode: 2, reason: 'first frame was not weft.authenticate' },
  };
}

async function runMainReadLoop(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  initialBuffer: string,
  maxFrameBytes: number,
  session: { handleMessage(line: string): Promise<void> },
  io: SessionIO,
): Promise<string> {
  let buffer = initialBuffer;
  // After emitting an overflow fault, we cannot trust that the byte
  // stream's next frame boundary is real — the attacker could have
  // crafted the oversized payload so a synthetic `\n` + fresh JSON
  // appears later in the same logical frame. Discard bytes until we
  // see a newline *in the continuation*, then resume normal framing
  // on whatever follows.
  let discardingOversize = false;
  while (true) {
    const result = await reader.read();
    if (result.done) {
      if (buffer.trim().length > 0) {
        // A partial frame without a trailing newline is a framing
        // violation on a stream whose contract is newline-delimited.
        // Emit a parse-error before the `finally` closes the writer,
        // so the client sees why the last call never got a response.
        await io.writeFrame({
          jsonrpc: JSON_RPC_VERSION,
          error: {
            code: JSON_RPC_ERROR_CODES.PARSE_ERROR,
            message: 'unterminated frame at stream close',
          },
          id: null,
        });
      }
      return '';
    }
    buffer += decoder.decode(result.value, { stream: true });
    if (discardingOversize) {
      const resumeIndex = buffer.indexOf('\n');
      if (resumeIndex === -1) {
        buffer = '';
        continue;
      }
      buffer = buffer.slice(resumeIndex + 1);
      discardingOversize = false;
    }
    if (buffer.length > maxFrameBytes && buffer.indexOf('\n') === -1) {
      // A frame with no newline has exceeded the size cap. Emit a
      // single InvalidRequest, discard the oversized prefix, and
      // ignore everything up to the next newline boundary — we can't
      // trust that the next frame start is where the client says it
      // is, so resynchronize on the next delimiter rather than
      // letting the attacker pick where framing resumes.
      await io.writeFrame({
        jsonrpc: JSON_RPC_VERSION,
        error: {
          code: JSON_RPC_ERROR_CODES.INVALID_REQUEST,
          message: 'frame exceeds maxFrameBytes',
          data: { weftCode: 'InvalidParams', httpStatus: 400 },
        },
        id: null,
      });
      buffer = '';
      discardingOversize = true;
      continue;
    }
    const framed = splitNewlineDelimitedBuffer(buffer, '');
    buffer = framed.buffer;
    for (const line of framed.lines) {
      await session.handleMessage(line);
    }
  }
}

type ReadOneFrameResult =
  | { kind: 'ok'; line: string; remainder: string }
  | { kind: 'closed' }
  | { kind: 'overflow' };

/**
 * Read exactly one complete newline-terminated frame from `reader`,
 * starting from `initialBuffer`. Enforces `maxFrameBytes` so an
 * attacker cannot force unbounded memory growth before admission
 * completes. The remainder is the raw slice of the buffer after the
 * first newline — no lossy reconstruction.
 */
async function readOneFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  initialBuffer: string,
  maxFrameBytes: number,
): Promise<ReadOneFrameResult> {
  let buffer = initialBuffer;
  while (true) {
    const newlineIndex = buffer.indexOf('\n');
    if (newlineIndex !== -1) {
      if (newlineIndex > maxFrameBytes) return { kind: 'overflow' };
      const line = buffer.slice(0, newlineIndex).trim();
      const remainder = buffer.slice(newlineIndex + 1);
      if (line.length === 0) {
        // Blank framing artifact — keep reading for a real frame.
        buffer = remainder;
        continue;
      }
      return { kind: 'ok', line, remainder };
    }
    if (buffer.length > maxFrameBytes) return { kind: 'overflow' };
    const result = await reader.read();
    if (result.done) return { kind: 'closed' };
    buffer += decoder.decode(result.value, { stream: true });
  }
}

/**
 * Drain any complete frames already present in `buffer` (no new
 * reads) through `session.handleMessage`. Returns the leftover
 * partial-frame buffer. Used immediately after admission so a
 * pipelined auth+call chunk is processed without waiting for more
 * input.
 */
async function drainCompleteFramesFromBuffer(
  buffer: string,
  session: { handleMessage(line: string): Promise<void> },
): Promise<string> {
  const framed = splitNewlineDelimitedBuffer(buffer, '');
  for (const line of framed.lines) {
    await session.handleMessage(line);
  }
  return framed.buffer;
}

async function closeWriterSilent(writer: WritableStreamDefaultWriter<Uint8Array>): Promise<void> {
  try {
    await writer.close();
  } catch {
    // Writer may already be closed/errored; nothing to do.
  }
}

function asId(value: unknown): JsonRpcId {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

/**
 * Constant-time string comparison. Length leak is intentional and
 * acceptable here (tokens are fixed-size hex in the intended
 * deployment) — the goal is to prevent a per-character timing oracle
 * on same-length candidates. For startup-token mode the attacker
 * would need to already control the stdin side, so this is
 * defense-in-depth rather than a load-bearing mitigation.
 */
function constantTimeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

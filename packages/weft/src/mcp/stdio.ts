import type { Engine, RegistryAgnosticEngine } from '../core/engine.ts';
import { principalFromStdioLocal } from '../server/principal.ts';
import { dispatchMcpMessage } from './dispatcher.ts';
import { parseMcpMessage } from './protocol.ts';
import { McpSession, McpSessionManager, type McpSessionManagerOptions } from './session.ts';

/**
 * Admission modes for local MCP stdio sessions.
 *
 * @example
 * ```ts
 * import { type McpStdioAdmission } from '@lostgradient/weft/mcp';
 *
 * const admission: McpStdioAdmission = {
 *   kind: 'startup-token',
 *   token: 'change-me',
 * };
 * void admission;
 * ```
 */
export type McpStdioAdmission =
  | { readonly kind: 'allow-unauthenticated-local-admin' }
  | { readonly kind: 'startup-token'; readonly token: string }
  | { readonly kind: 'require-one' };

/**
 * Options for running a local MCP stdio session.
 *
 * @example
 * ```ts
 * import { type McpStdioSessionOptions } from '@lostgradient/weft/mcp';
 * import { Engine, MemoryStorage } from '@lostgradient/weft';
 *
 * await using storage = new MemoryStorage();
 * await using engine = new Engine({ storage });
 *
 * const options: McpStdioSessionOptions = {
 *   input: new ReadableStream<Uint8Array>(),
 *   output: new WritableStream<Uint8Array>(),
 *   engine,
 *   admission: { kind: 'require-one' },
 *   sessionManagerOptions: { maximumSessions: 1 },
 * };
 * void options;
 * ```
 */
export type McpStdioSessionOptions = {
  readonly input: ReadableStream<Uint8Array>;
  readonly output: WritableStream<Uint8Array>;
  /**
   * Typed as {@link RegistryAgnosticEngine} (see its JSDoc) rather than the
   * plain default `Engine`, so both `new Engine({ storage })` and
   * `Engine.create({ workflows })` type-check here directly.
   */
  readonly engine: RegistryAgnosticEngine;
  readonly admission: McpStdioAdmission;
  readonly maxFrameBytes?: number;
  readonly sessionManagerOptions?: McpSessionManagerOptions;
};

/**
 * Result of a completed MCP stdio session.
 *
 * @example
 * ```ts
 * import { type McpStdioSessionResult } from '@lostgradient/weft/mcp';
 *
 * const result: McpStdioSessionResult = { exitCode: 0 };
 * process.exitCode = result.exitCode;
 * ```
 */
export type McpStdioSessionResult = {
  readonly exitCode: number;
  readonly reason?: string;
};

const DEFAULT_MAX_FRAME_BYTES = 1_048_576;

/**
 * Run a newline-delimited MCP JSON-RPC stdio session against a local engine.
 *
 * @example
 * ```ts
 * import { runMcpStdioSession } from '@lostgradient/weft/mcp';
 * import { Engine, MemoryStorage } from '@lostgradient/weft';
 *
 * await using storage = new MemoryStorage();
 * await using engine = new Engine({ storage });
 *
 * const result = await runMcpStdioSession({
 *   input: new ReadableStream<Uint8Array>(),
 *   output: new WritableStream<Uint8Array>(),
 *   engine,
 *   admission: { kind: 'require-one' },
 * });
 * void result;
 * ```
 */
export async function runMcpStdioSession(
  options: McpStdioSessionOptions,
): Promise<McpStdioSessionResult> {
  if (options.admission.kind === 'require-one') {
    return {
      exitCode: 2,
      reason:
        'MCP stdio admission required: pass --startup-token <token> or --allow-unauthenticated-local-admin',
    };
  }
  if (options.admission.kind === 'startup-token' && options.admission.token.trim().length === 0) {
    return { exitCode: 2, reason: 'MCP stdio startup token must be non-empty' };
  }

  const runtime = createStdioRuntime(options);
  const pending = new Set<Promise<void>>();

  try {
    const admitted = await runAdmission(options, runtime);
    if (!admitted.ok) {
      await closeRuntime(runtime);
      return admitted.result;
    }
    await runMainReadLoop(options, runtime, admitted.remainder, pending);
    await Promise.all(pending);
    await closeRuntime(runtime);
    return { exitCode: 0 };
  } catch (error) {
    await closeRuntime(runtime, true);
    return { exitCode: 1, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    runtime.reader.releaseLock();
  }
}

type StdioRuntime = {
  readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly write: SerializedWriter;
  readonly manager: McpSessionManager;
  readonly session: McpSession;
  readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly decoder: TextDecoder;
};

function createStdioRuntime(options: McpStdioSessionOptions): StdioRuntime {
  const writer = options.output.getWriter();
  const write = createSerializedWriter(writer);
  const manager = new McpSessionManager(options.engine, options.sessionManagerOptions);
  const session = manager.add(new McpSession('stdio-local', principalFromStdioLocal()));
  session.addTarget((message) => {
    manager.touch(session);
    void write(JSON.stringify(message));
  });
  return {
    writer,
    write,
    manager,
    session,
    reader: options.input.getReader(),
    decoder: new TextDecoder(),
  };
}

async function runAdmission(
  options: McpStdioSessionOptions,
  runtime: StdioRuntime,
): Promise<
  | { readonly ok: true; readonly remainder: string }
  | { readonly ok: false; readonly result: McpStdioSessionResult }
> {
  if (options.admission.kind !== 'startup-token') {
    return { ok: true, remainder: '' };
  }
  return runStartupTokenAdmission(
    runtime.reader,
    runtime.decoder,
    options.admission.token,
    runtime.write,
    options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
  );
}

async function runMainReadLoop(
  options: McpStdioSessionOptions,
  runtime: StdioRuntime,
  initialBuffer: string,
  pending: Set<Promise<void>>,
): Promise<void> {
  let buffer = initialBuffer;
  while (true) {
    const chunk = await runtime.reader.read();
    if (chunk.done) break;
    buffer = await appendChunkAndDispatch(buffer, chunk.value, options, runtime, pending);
  }
  if (buffer.trim().length > 0) addPendingLine(buffer, options, runtime, pending);
}

async function appendChunkAndDispatch(
  buffer: string,
  chunk: Uint8Array,
  options: McpStdioSessionOptions,
  runtime: StdioRuntime,
  pending: Set<Promise<void>>,
): Promise<string> {
  const nextBuffer = buffer + runtime.decoder.decode(chunk, { stream: true });
  if (nextBuffer.length > (options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES)) {
    await runtime.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'frame exceeds maxFrameBytes' },
      }),
    );
    return '';
  }
  const lines = nextBuffer.split('\n');
  for (const line of lines.slice(0, -1)) addPendingLine(line, options, runtime, pending);
  return lines.at(-1) ?? '';
}

function addPendingLine(
  line: string,
  options: McpStdioSessionOptions,
  runtime: StdioRuntime,
  pending: Set<Promise<void>>,
): void {
  if (line.trim().length === 0) return;
  runtime.manager.touch(runtime.session);
  // Registry-erase the widened `McpStdioSessionOptions.engine` back to the
  // plain default `Engine` `handleLine` expects — see this option's JSDoc / #708.
  const task = handleLine(line, options.engine as Engine, runtime.session, runtime.write).finally(
    () => {
      pending.delete(task);
    },
  );
  pending.add(task);
}

async function closeRuntime(runtime: StdioRuntime, ignoreWriterError = false): Promise<void> {
  await runtime.manager[Symbol.asyncDispose]();
  await runtime.write.drain();
  if (ignoreWriterError) {
    await runtime.writer.close().catch(() => undefined);
    return;
  }
  await runtime.writer.close();
}

async function runStartupTokenAdmission(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  expectedToken: string,
  write: SerializedWriter,
  maxFrameBytes: number,
): Promise<
  | { readonly ok: true; readonly remainder: string }
  | { readonly ok: false; readonly result: McpStdioSessionResult }
> {
  const frame = await readAuthenticationFrame(reader, decoder, write, maxFrameBytes);
  if (!frame.ok) return frame;

  const authenticated = await authenticateFrame(frame.line, expectedToken, write);
  if (!authenticated.ok) return authenticated;

  return { ok: true, remainder: frame.remainder };
}

async function readAuthenticationFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  write: SerializedWriter,
  maxFrameBytes: number,
): Promise<
  | { readonly ok: true; readonly line: string; readonly remainder: string }
  | { readonly ok: false; readonly result: McpStdioSessionResult }
> {
  let buffer = '';
  while (!buffer.includes('\n')) {
    const chunk = await reader.read();
    if (chunk.done) {
      return {
        ok: false,
        result: { exitCode: 2, reason: 'stdio session closed before authenticate frame' },
      };
    }
    buffer += decoder.decode(chunk.value, { stream: true });
    if (buffer.length > maxFrameBytes) {
      await write(
        JSON.stringify(authenticationError(null, 'authenticate frame exceeds maxFrameBytes')),
      );
      return {
        ok: false,
        result: { exitCode: 2, reason: 'authenticate frame exceeds maxFrameBytes' },
      };
    }
  }

  const newlineIndex = buffer.indexOf('\n');
  return {
    ok: true,
    line: buffer.slice(0, newlineIndex),
    remainder: buffer.slice(newlineIndex + 1),
  };
}

async function authenticateFrame(
  line: string,
  expectedToken: string,
  write: SerializedWriter,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly result: McpStdioSessionResult }> {
  const parsed = parseAuthenticationLine(line);
  if (!parsed.ok) {
    await write(JSON.stringify(authenticationError(null, 'first frame was not valid JSON')));
    return { ok: false, result: { exitCode: 2, reason: 'first frame was not valid JSON' } };
  }

  const token = tokenFromParams(parsed.record['params']);
  if (parsed.record['method'] !== 'weft.authenticate' || token !== expectedToken) {
    await write(JSON.stringify(authenticationError(parsed.id, 'startup token mismatch')));
    return { ok: false, result: { exitCode: 2, reason: 'startup token mismatch' } };
  }

  await write(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: {} }));
  return { ok: true };
}

function parseAuthenticationLine(
  line: string,
):
  | { readonly ok: true; readonly record: Record<string, unknown>; readonly id: unknown }
  | { readonly ok: false } {
  const parsed = parseMcpMessage(line);
  if (!parsed.ok || parsed.value === null || typeof parsed.value !== 'object') {
    return { ok: false };
  }
  const record = parsed.value as Record<string, unknown>;
  return { ok: true, record, id: record['id'] ?? null };
}

function tokenFromParams(params: unknown): unknown {
  if (params !== null && typeof params === 'object' && !Array.isArray(params)) {
    return (params as Record<string, unknown>)['token'];
  }
  return undefined;
}

function authenticationError(id: unknown, message: string): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: typeof id === 'string' || typeof id === 'number' || id === null ? id : null,
    error: { code: -32010, message },
  };
}

async function handleLine(
  line: string,
  engine: Engine,
  session: McpSession,
  write: SerializedWriter,
): Promise<void> {
  const parsed = parseMcpMessage(line);
  if (!parsed.ok) {
    await write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      }),
    );
    return;
  }

  const result = await dispatchMcpMessage(parsed.value, {
    engine,
    session,
    principal: session.principal,
    authRequired: false,
  });
  if (result.kind === 'response') {
    await write(JSON.stringify(result.response));
  }
}

type SerializedWriter = {
  (line: string): Promise<void>;
  drain(): Promise<void>;
};

function createSerializedWriter(writer: WritableStreamDefaultWriter<Uint8Array>): SerializedWriter {
  const encoder = new TextEncoder();
  let chain: Promise<void> = Promise.resolve();
  const write = ((line: string) => {
    const next = chain.then(() => writer.write(encoder.encode(`${line}\n`)));
    chain = next.catch(() => undefined);
    return next;
  }) as SerializedWriter;
  write.drain = async () => {
    await chain.catch(() => undefined);
  };
  return write;
}

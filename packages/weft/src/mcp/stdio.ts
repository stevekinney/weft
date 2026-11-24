import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { WEFT_SCOPE_VOCABULARY } from '../authorization-scopes.ts';

import { principalFromStdioLocal } from "../embedded/backchannel/src/index.ts";
import type { Engine, RegistryAgnosticEngine } from '../core/engine.ts';
import { McpChangeFeed } from './change-feed.ts';
import { createMcpServerFactory, type McpServerRegistrar } from './server.ts';
import { StreamLineTransport } from './stream-line-transport.ts';

/**
 * Admission modes for local MCP stdio sessions.
 *
 * @example
 * ```ts
 * import { type McpStdioAdmission } from '@lostgradient/weft';
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
 * import { type McpStdioSessionOptions } from '@lostgradient/weft';
 * import { Engine } from '@lostgradient/weft';
 * import { MemoryStorage } from '@lostgradient/storage';
 *
 * await using storage = new MemoryStorage();
 * await using engine = new Engine({ storage });
 *
 * const options: McpStdioSessionOptions = {
 *   input: new ReadableStream<Uint8Array>(),
 *   output: new WritableStream<Uint8Array>(),
 *   engine,
 *   admission: { kind: 'require-one' },
 *   maxFrameBytes: 64 * 1024,
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
  /** Registers further tools or prompts on the connection's server instance. */
  readonly registrars?: ReadonlyArray<McpServerRegistrar>;
};

/**
 * Result of a completed MCP stdio session.
 *
 * @example
 * ```ts
 * import { type McpStdioSessionResult } from '@lostgradient/weft';
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
 * Run a newline-delimited MCP stdio session against a local engine. After the
 * Weft admission step, the official MCP SDK serves the connection: the opening
 * exchange selects the protocol era and one server instance is pinned for the
 * rest of the connection.
 *
 * @example
 * ```ts
 * import { runMcpStdioSession } from '@lostgradient/weft';
 * import { Engine } from '@lostgradient/weft';
 * import { MemoryStorage } from '@lostgradient/storage';
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

  const writer = options.output.getWriter();
  const write = createSerializedWriter(writer);
  const reader = options.input.getReader();
  const decoder = new TextDecoder();

  try {
    const admitted = await runAdmission(options, reader, decoder, write);
    if (!admitted.ok) {
      await closeWriter(writer, write);
      return admitted.result;
    }
    await serveConnection(options, reader, decoder, write, admitted.remainder);
    await closeWriter(writer, write);
    return { exitCode: 0 };
  } catch (error) {
    await closeWriter(writer, write, true);
    return { exitCode: 1, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    reader.releaseLock();
  }
}

async function runAdmission(
  options: McpStdioSessionOptions,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  write: SerializedWriter,
): Promise<
  | { readonly ok: true; readonly remainder: string }
  | { readonly ok: false; readonly result: McpStdioSessionResult }
> {
  if (options.admission.kind !== 'startup-token') {
    return { ok: true, remainder: '' };
  }
  return runStartupTokenAdmission(
    reader,
    decoder,
    options.admission.token,
    write,
    options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
  );
}

/**
 * Serve the admitted connection through the SDK until the input ends, then
 * let every request already read finish before closing the connection.
 */
async function serveConnection(
  options: McpStdioSessionOptions,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  write: SerializedWriter,
  remainder: string,
): Promise<void> {
  // Registry-erase the widened `McpStdioSessionOptions.engine` (#708).
  const engine = options.engine as Engine;
  await using feed = new McpChangeFeed(engine);
  const transport = new StreamLineTransport(write);
  const principal = principalFromStdioLocal(WEFT_SCOPE_VOCABULARY);
  // Work a call starts and does not await (cancelling the workflow of a cancelled call) must
  // finish before the session ends, or the process can exit with the workflow still running.
  const pendingWork = new Set<Promise<unknown>>();
  const trackPendingWork = (work: Promise<unknown>): void => {
    pendingWork.add(work);
    void work.finally(() => pendingWork.delete(work));
  };
  const connection = serveStdio(
    createMcpServerFactory({
      engine,
      access: () => ({ principal, authRequired: false }),
      lifetime: 'connection',
      feed,
      registrars: options.registrars ?? [],
      trackPendingWork,
    }),
    { transport },
  );
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  let buffer = remainder;
  buffer = await deliverLines(buffer, transport, maxFrameBytes);
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer = await deliverLines(
      buffer + decoder.decode(chunk.value, { stream: true }),
      transport,
      maxFrameBytes,
    );
  }
  if (buffer.trim().length > 0) transport.receive(buffer);
  await transport.settled();
  await Promise.allSettled(pendingWork);
  await connection.close();
}

/** Hand every complete line to the transport and return the unterminated rest. */
async function deliverLines(
  buffer: string,
  transport: StreamLineTransport,
  maxFrameBytes: number,
): Promise<string> {
  if (buffer.length > maxFrameBytes) {
    await transport.reject(null, -32600, 'frame exceeds maxFrameBytes');
    return '';
  }
  const lines = buffer.split('\n');
  for (const line of lines.slice(0, -1)) {
    if (line.trim().length > 0) transport.receive(line);
  }
  return lines.at(-1) ?? '';
}

async function closeWriter(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  write: SerializedWriter,
  ignoreWriterError = false,
): Promise<void> {
  await write.drain();
  if (ignoreWriterError) {
    await writer.close().catch(() => undefined);
    return;
  }
  await writer.close();
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
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { ok: false };
  }
  if (value === null || typeof value !== 'object') return { ok: false };
  const record = value as Record<string, unknown>;
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

/**
 * `weft tail <workflow-id>` — stream a workflow's token events as they replay
 * from the server's Server-Sent Events endpoint (`GET /v1/workflows/:id/sse`).
 *
 * Each SSE frame is parsed into a structured event and emitted as one line:
 * a compact JSON object under `--json` (valid NDJSON), or a TTY-formatted line
 * otherwise. The stream ends on the server's `done` event, when the connection
 * closes, or when the caller aborts (Ctrl-C) — all of which resolve cleanly
 * with exit code 0 rather than leaving the reader hanging.
 *
 * The consumer is factored as {@link streamWorkflowEvents} so tests drive it
 * with an injected `fetch` and `AbortSignal` instead of a real terminal.
 *
 * @module cli/tail
 */

import { resolveConnection, type ConnectionOptions } from '../connection.ts';
import { color, messageOf } from './output.ts';
import type { CommandOutput, TailCommand } from './types.ts';

/** A single parsed SSE frame surfaced to the tail sink. */
export type TailEvent = {
  readonly id?: string;
  readonly event: string;
  readonly data: string;
};

/** Minimal `fetch` shape the tail consumer needs; lets tests inject a stub. */
export type TailFetch = (url: URL, init: RequestInit) => Promise<Response>;

/** Dependencies injected into {@link streamWorkflowEvents} for testing. */
export type TailStreamOptions = {
  readonly url: URL;
  readonly token?: string;
  readonly signal: AbortSignal;
  /** Sink for streamed events (stdout, suppressed under `--quiet`). */
  readonly write: (line: string) => void;
  /** Sink for connection/status errors (stderr, never suppressed). Defaults to `write`. */
  readonly reportError?: (line: string) => void;
  readonly json: boolean;
  readonly fetchImpl?: TailFetch;
};

function sseEndpoint(server: URL, workflowId: string): URL {
  const endpoint = new URL(server.toString());
  const basePath = endpoint.pathname.endsWith('/') ? endpoint.pathname : `${endpoint.pathname}/`;
  endpoint.pathname = `${basePath}v1/workflows/${encodeURIComponent(workflowId)}/sse`.replaceAll(
    /\/+/g,
    '/',
  );
  endpoint.search = '';
  endpoint.hash = '';
  return endpoint;
}

/** Split one SSE line into its field name and value (per the SSE grammar). */
function parseFieldLine(rawLine: string): { field: string; value: string } | undefined {
  if (rawLine === '' || rawLine.startsWith(':')) return undefined;
  const colonIndex = rawLine.indexOf(':');
  const field = colonIndex === -1 ? rawLine : rawLine.slice(0, colonIndex);
  const valueRaw = colonIndex === -1 ? '' : rawLine.slice(colonIndex + 1);
  return { field, value: valueRaw.startsWith(' ') ? valueRaw.slice(1) : valueRaw };
}

/** Parse one `\n\n`-delimited SSE frame block into a {@link TailEvent}. */
function parseFrame(block: string): TailEvent | undefined {
  let id: string | undefined;
  let event = 'message';
  const dataLines: string[] = [];
  for (const rawLine of block.split('\n')) {
    const parsed = parseFieldLine(rawLine);
    if (parsed === undefined) continue;
    if (parsed.field === 'id') id = parsed.value;
    else if (parsed.field === 'event') event = parsed.value;
    else if (parsed.field === 'data') dataLines.push(parsed.value);
  }
  if (id === undefined && dataLines.length === 0 && event === 'message') return undefined;
  return { ...(id === undefined ? {} : { id }), event, data: dataLines.join('\n') };
}

function formatEvent(frame: TailEvent, json: boolean): string {
  if (json) {
    return JSON.stringify({
      ...(frame.id === undefined ? {} : { id: frame.id }),
      event: frame.event,
      data: frame.data,
    });
  }
  const prefix = frame.id === undefined ? '' : `${color.dim(`[${frame.id}]`)} `;
  return `${prefix}${color.cyan(frame.event)}  ${frame.data}`;
}

type ConnectOutcome =
  | { readonly kind: 'stream'; readonly body: ReadableStream<Uint8Array> }
  | { readonly kind: 'done'; readonly exitCode: number };

async function connectSse(options: TailStreamOptions): Promise<ConnectOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers = new Headers({ Accept: 'text/event-stream' });
  if (options.token !== undefined && options.token !== '') {
    headers.set('authorization', `Bearer ${options.token}`);
  }

  const reportError = options.reportError ?? options.write;
  let response: Response;
  try {
    response = await fetchImpl(options.url, { method: 'GET', headers, signal: options.signal });
  } catch (error) {
    if (options.signal.aborted) return { kind: 'done', exitCode: 0 };
    reportError(`tail: connection failed: ${messageOf(error)}`);
    return { kind: 'done', exitCode: 2 };
  }

  if (!response.ok || response.body === null) {
    reportError(`tail: server returned status ${response.status}`);
    // HTTP error responses are operation failures (exit 1), not connection errors
    // (exit 2). Exit 2 is reserved for when the server cannot be reached at all.
    return { kind: 'done', exitCode: 1 };
  }
  return { kind: 'stream', body: response.body };
}

/**
 * Drain complete `\n\n`-delimited frames from `buffer`, emitting each through
 * `write`. Returns the carried-over buffer remainder, or `null` when a `done`
 * event signals the stream should end.
 */
function drainFrames(buffer: string, options: TailStreamOptions): string | null {
  let separatorIndex = buffer.indexOf('\n\n');
  while (separatorIndex !== -1) {
    const block = buffer.slice(0, separatorIndex);
    buffer = buffer.slice(separatorIndex + 2);
    const frame = parseFrame(block);
    if (frame !== undefined) {
      if (frame.event === 'done') return null;
      options.write(formatEvent(frame, options.json));
    }
    separatorIndex = buffer.indexOf('\n\n');
  }
  return buffer;
}

/**
 * Connect to the workflow SSE endpoint and emit each frame through `write`.
 * Resolves when the stream ends, the server emits `done`, or the signal aborts.
 * Returns the exit code (0 on a clean end/abort, non-zero on a failed connect).
 */
export async function streamWorkflowEvents(options: TailStreamOptions): Promise<number> {
  const outcome = await connectSse(options);
  if (outcome.kind === 'done') return outcome.exitCode;

  const reader = outcome.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const onAbort = () => void reader.cancel().catch(() => undefined);
  options.signal.addEventListener('abort', onAbort, { once: true });

  try {
    for (;;) {
      let value: Uint8Array | undefined;
      try {
        const chunk = await reader.read();
        if (chunk.done) return 0;
        value = chunk.value;
      } catch (error) {
        // Reader cancelled by abort signal: end cleanly.
        if (options.signal.aborted) return 0;
        // Stream errored mid-read (e.g. network reset, server crash): report it.
        const reportError = options.reportError ?? options.write;
        reportError(
          `tail: stream error: ${error instanceof Error ? error.message : String(error)}`,
        );
        return 2;
      }
      if (value === undefined) return 0;
      buffer += decoder.decode(value, { stream: true });
      const remainder = drainFrames(buffer, options);
      if (remainder === null) return 0;
      buffer = remainder;
    }
  } finally {
    options.signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Execute `weft tail`. Wires the process's SIGINT into an `AbortController` so
 * Ctrl-C ends the stream cleanly, and writes events to stdout. A bare
 * `weft tail` with no workflow id is not yet supported (system-wide tail needs
 * a server-side multiplexed SSE route); it returns a usage error pointing at
 * the per-workflow form.
 */
export async function executeTail(command: TailCommand): Promise<CommandOutput> {
  if (command.workflowId === undefined || command.workflowId === '') {
    return {
      stdout: '',
      stderr:
        'tail: a workflow id is required (system-wide tail is not yet available). Usage: weft tail <workflow-id>',
      exitCode: 3,
    };
  }

  const connection: ConnectionOptions = {
    ...(command.server === undefined ? {} : { server: command.server }),
    ...(command.token === undefined ? {} : { token: command.token }),
    ...(command.profile === undefined ? {} : { profile: command.profile }),
  };
  let resolved: ReturnType<typeof resolveConnection>;
  try {
    resolved = resolveConnection(connection);
  } catch (error) {
    return {
      stdout: '',
      stderr: `tail: connection error: ${messageOf(error)}`,
      exitCode: 2,
    };
  }
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.on('SIGINT', onSigint);

  try {
    const exitCode = await streamWorkflowEvents({
      url: sseEndpoint(resolved.server, command.workflowId),
      ...(resolved.token === undefined ? {} : { token: resolved.token }),
      signal: controller.signal,
      write: (line) => {
        if (!command.quiet) process.stdout.write(`${line}\n`);
      },
      // Connection/status errors always reach stderr, even under --quiet, so a
      // failed tail is never silent.
      reportError: (line) => process.stderr.write(`${line}\n`),
      json: command.json,
    });
    return { stdout: '', exitCode };
  } finally {
    process.off('SIGINT', onSigint);
  }
}

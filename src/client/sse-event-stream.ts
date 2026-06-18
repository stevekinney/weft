import { WORKFLOW_TERMINAL_EVENT_TYPES } from '../core/events/workflow-events.ts';
import type { WorkflowEvent } from '../core/types.ts';
import type { StreamCloseReason } from './event-stream.ts';
import type { WorkflowEventTail } from './event-tail.ts';

export type ServerSentEventFrame = {
  readonly id?: string;
  readonly event?: string;
  readonly data: string;
};

export type ServerSentEventParseResult = {
  readonly frames: ReadonlyArray<ServerSentEventFrame>;
  readonly remainder: string;
};

export type SseWorkflowEventStreamOptions = {
  readonly maxReconnectAttempts?: number;
  readonly reconnectBackoffMs?: number;
  readonly bufferForIteration?: boolean;
};

type ServerSentEventFrameHandling = 'ignored' | 'healthy' | 'server-error';

type WorkflowEventEnvelope = {
  readonly kind: string;
  readonly workflowId: string;
  readonly selector: 'events' | 'tokens';
  readonly sequence: number;
  readonly cursor: string;
  readonly emittedAtMs: number;
  readonly payload: unknown;
};

type ServerSentEventFrameParts = {
  id: string | undefined;
  event: string | undefined;
  dataLines: string[];
};

const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;
const DEFAULT_RECONNECT_BACKOFF_MS = 50;

export function workflowEventsSseUrl(baseUrl: string, workflowId: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return `${trimmed}/v1/workflows/${encodeURIComponent(workflowId)}/events/sse`;
}

export function parseServerSentEventChunk(
  text: string,
  previousRemainder = '',
): ServerSentEventParseResult {
  const combined = `${previousRemainder}${text}`.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const parts = combined.split('\n\n');
  const remainder = parts.pop() ?? '';
  const frames = parts.map(parseServerSentEventFrame).filter((frame) => frame !== null);
  return { frames, remainder };
}

function parseServerSentEventFrame(block: string): ServerSentEventFrame | null {
  const parts: ServerSentEventFrameParts = {
    id: undefined,
    event: undefined,
    dataLines: [],
  };

  for (const rawLine of block.split('\n')) {
    applyServerSentEventLine(parts, rawLine);
  }

  return frameFromParts(parts);
}

function applyServerSentEventLine(parts: ServerSentEventFrameParts, rawLine: string): void {
  if (rawLine === '' || rawLine.startsWith(':')) return;
  const { field, value } = splitServerSentEventLine(rawLine);
  if (field === 'id') {
    parts.id = value;
  } else if (field === 'event') {
    parts.event = value;
  } else if (field === 'data') {
    parts.dataLines.push(value);
  }
}

function splitServerSentEventLine(rawLine: string): { field: string; value: string } {
  const separator = rawLine.indexOf(':');
  const field = separator === -1 ? rawLine : rawLine.slice(0, separator);
  const rawValue = separator === -1 ? '' : rawLine.slice(separator + 1);
  return {
    field,
    value: rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue,
  };
}

function frameFromParts(parts: ServerSentEventFrameParts): ServerSentEventFrame | null {
  if (parts.id === undefined && parts.event === undefined && parts.dataLines.length === 0) {
    return null;
  }
  return {
    ...(parts.id === undefined ? {} : { id: parts.id }),
    ...(parts.event === undefined ? {} : { event: parts.event }),
    data: parts.dataLines.join('\n'),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseWorkflowEventEnvelope(data: string): WorkflowEventEnvelope | null {
  const parsed = parseJson(data);
  if (!isRecord(parsed)) return null;
  return workflowEventEnvelopeFromRecord(parsed);
}

function parseJson(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function workflowEventEnvelopeFromRecord(
  parsed: Record<string, unknown>,
): WorkflowEventEnvelope | null {
  if (typeof parsed['kind'] !== 'string') return null;
  if (typeof parsed['workflowId'] !== 'string') return null;
  if (!isWorkflowEventSelector(parsed['selector'])) return null;
  const sequence = finiteNumber(parsed['sequence']);
  if (sequence === null) return null;
  if (typeof parsed['cursor'] !== 'string') return null;
  const emittedAtMs = finiteNumber(parsed['emittedAtMs']);
  if (emittedAtMs === null) return null;
  if (!Object.hasOwn(parsed, 'payload')) return null;
  return {
    kind: parsed['kind'],
    workflowId: parsed['workflowId'],
    selector: parsed['selector'],
    sequence,
    cursor: parsed['cursor'],
    emittedAtMs,
    payload: parsed['payload'],
  };
}

function isWorkflowEventSelector(value: unknown): value is WorkflowEventEnvelope['selector'] {
  return value === 'events' || value === 'tokens';
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function envelopeToWorkflowEvent(envelope: WorkflowEventEnvelope): WorkflowEvent {
  return {
    type: envelope.kind,
    timestamp: envelope.emittedAtMs,
    data: isRecord(envelope.payload) ? envelope.payload : { value: envelope.payload },
  };
}

function isEventStreamResponse(response: Response): boolean {
  const contentType = response.headers.get('Content-Type');
  if (contentType === null) return false;
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase();
  return mediaType === 'text/event-stream';
}

export class SseWorkflowEventSubscription implements WorkflowEventTail {
  readonly #url: string;
  readonly #headers: Record<string, string>;
  readonly #workflowId: string;
  readonly #onEvent: (event: WorkflowEvent) => void;
  readonly #maxReconnectAttempts: number;
  readonly #reconnectBackoffMs: number;
  readonly #buffer: WorkflowEvent[] = [];
  readonly #connected: ReturnType<typeof Promise.withResolvers<void>> = Promise.withResolvers();

  #connectedSettled = false;
  #closed = false;
  #closeReason: StreamCloseReason | null = null;
  #iterating = false;
  #waker: (() => void) | null = null;
  #abortController: AbortController | null = null;
  #reconnectAttempts = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #lastEventId: string | null = null;

  constructor(
    url: string,
    headers: Record<string, string>,
    workflowId: string,
    onEvent: (event: WorkflowEvent) => void,
    options?: SseWorkflowEventStreamOptions,
  ) {
    this.#url = url;
    this.#headers = headers;
    this.#workflowId = workflowId;
    this.#onEvent = onEvent;
    this.#maxReconnectAttempts = options?.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    this.#reconnectBackoffMs = options?.reconnectBackoffMs ?? DEFAULT_RECONNECT_BACKOFF_MS;
    this.#iterating = options?.bufferForIteration ?? false;
    void this.#connect();
  }

  get closeReason(): StreamCloseReason | null {
    return this.#closeReason;
  }

  whenConnected(): Promise<void> {
    return this.#connected.promise;
  }

  async #connect(): Promise<void> {
    if (this.#closed) return;
    const abortController = new AbortController();
    this.#abortController = abortController;
    try {
      const response = await fetch(this.#url, {
        headers: this.#requestHeaders(),
        signal: abortController.signal,
      });
      if (!response.ok || response.body === null) {
        this.#scheduleReconnect();
        return;
      }
      if (!isEventStreamResponse(response)) {
        this.#scheduleReconnect();
        return;
      }
      this.#markConnected();
      await this.#readResponseBody(response.body);
      if (!this.#closed) this.#scheduleReconnect();
    } catch {
      if (!this.#closed) this.#scheduleReconnect();
    } finally {
      if (this.#abortController === abortController) {
        this.#abortController = null;
      }
    }
  }

  #requestHeaders(): Headers {
    const headers = new Headers(this.#headers);
    headers.set('Accept', 'text/event-stream');
    headers.set('Cache-Control', 'no-cache');
    if (this.#lastEventId !== null) {
      headers.set('Last-Event-ID', this.#lastEventId);
    }
    return headers;
  }

  async #readResponseBody(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let remainder = '';
    try {
      while (!this.#closed) {
        const chunk = await reader.read();
        if (chunk.done) return;
        const parsed = parseServerSentEventChunk(
          decoder.decode(chunk.value, { stream: true }),
          remainder,
        );
        remainder = parsed.remainder;
        for (const frame of parsed.frames) {
          const handling = this.#handleFrame(frame);
          if (this.#closed || handling === 'server-error') return;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  #handleFrame(frame: ServerSentEventFrame): ServerSentEventFrameHandling {
    if (frame.event === 'ping') {
      this.#markHealthyConnection();
      return 'healthy';
    }
    if (frame.event === 'error') {
      this.#abortController?.abort();
      return 'server-error';
    }
    const envelope = parseWorkflowEventEnvelope(frame.data);
    if (envelope === null) return 'ignored';
    if (envelope.workflowId !== this.#workflowId) return 'ignored';
    this.#lastEventId = frame.id ?? envelope.cursor;
    this.#markHealthyConnection();
    this.#emit(envelopeToWorkflowEvent(envelope));
    return 'healthy';
  }

  #emit(event: WorkflowEvent): void {
    if (this.#closed) return;
    try {
      this.#onEvent(event);
    } catch {
      // Listener failures must not corrupt stream state.
    }
    if (this.#iterating) {
      this.#buffer.push(event);
      this.#wake();
    }
    if (WORKFLOW_TERMINAL_EVENT_TYPES.has(event.type)) {
      this.#terminate('workflow-terminal');
    }
  }

  #scheduleReconnect(): void {
    if (this.#closed || this.#reconnectTimer !== null) return;
    if (this.#reconnectAttempts >= this.#maxReconnectAttempts) {
      this.#terminate('reconnect-exhausted');
      return;
    }
    this.#reconnectAttempts += 1;
    const delay = this.#reconnectBackoffMs * this.#reconnectAttempts;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.#connect();
    }, delay);
  }

  #markConnected(): void {
    if (this.#connectedSettled) return;
    this.#connectedSettled = true;
    this.#connected.resolve();
  }

  #markHealthyConnection(): void {
    this.#reconnectAttempts = 0;
    this.#markConnected();
  }

  #terminate(reason: StreamCloseReason): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeReason = reason;
    this.#markConnected();
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#abortController?.abort();
    this.#abortController = null;
    this.#wake();
  }

  close(): void {
    this.#terminate('client-closed');
  }

  [Symbol.asyncIterator](): AsyncIterator<WorkflowEvent> {
    this.#iterating = true;
    return this.#iterate();
  }

  async *#iterate(): AsyncIterator<WorkflowEvent> {
    try {
      while (true) {
        while (this.#buffer.length > 0) {
          yield this.#buffer.shift()!;
        }
        if (this.#closed) return;
        await this.#waitForEvent();
      }
    } finally {
      this.#iterating = false;
      this.close();
    }
  }

  #waitForEvent(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#waker = resolve;
    return promise;
  }

  #wake(): void {
    const waker = this.#waker;
    if (waker !== null) {
      this.#waker = null;
      waker();
    }
  }
}

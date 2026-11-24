import { faultWireAdvice } from '../fault-remediation.ts';
import { extractFaultDataPayload } from '../fault-to-json-rpc.ts';
import { wireSafeFault } from '../fault-wire-safety.ts';
import { invalidParamsFault, isOperationFault } from '../operation-fault-helpers.ts';
import {
  shapeRestFaultAsJson,
  type OperationFault,
  type RestFaultResponseOptions,
} from '../operation-fault.ts';
import { decodeCursor, type Cursor } from '../sequence-cursor.ts';

const textEncoder = new TextEncoder();

export type ServerSentEventTimerScheduler = (
  callback: () => void,
  intervalMs: number,
) => () => void;

export type ServerSentEventHeartbeatOptions = {
  readonly intervalMs: number;
  readonly schedule?: ServerSentEventTimerScheduler;
  readonly now?: () => number;
};

type ServerSentEventEnvelope = {
  readonly kind: string;
  readonly cursor: string;
  readonly emittedAtMs: number;
};

type EventEnvelopeSSEStreamOptions<TEnvelope extends ServerSentEventEnvelope> = {
  readonly iterable: AsyncIterable<TEnvelope>;
  readonly close: () => Promise<void>;
  readonly ready?: Promise<void>;
  readonly heartbeat?: ServerSentEventHeartbeatOptions;
  readonly signal?: AbortSignal;
  /**
   * Ends the response cleanly once this many milliseconds have passed, so a
   * client resumes with `Last-Event-ID`. Armed through the heartbeat's
   * `schedule`, which keeps one timer seam for tests.
   */
  readonly maxDurationMs?: number;
};

/** How often a quiet event stream sends a `ping`, so a connection that is open is never silent for longer. */
export const DEFAULT_SSE_HEARTBEAT_INTERVAL_MS = 15_000;
export const SSE_ACCEPT_REQUIRED_MESSAGE = 'Accept header must include text/event-stream';

export function acceptsServerSentEvents(acceptHeader: string | null): boolean {
  if (acceptHeader === null) return false;

  for (const entry of acceptHeader.split(',')) {
    const mediaType = entry.split(';', 1)[0]?.trim().toLowerCase();
    if (mediaType === 'text/event-stream' || mediaType === 'text/*' || mediaType === '*/*') {
      return true;
    }
  }

  return false;
}

/** Throws unless the request accepts `text/event-stream`. */
export function requireServerSentEventsAccept(request: Request): void {
  if (!acceptsServerSentEvents(request.headers.get('Accept'))) {
    throw invalidParamsFault(SSE_ACCEPT_REQUIRED_MESSAGE);
  }
}

/**
 * Validate an SSE reconnect cursor taken from a `Last-Event-ID` header or
 * `fromCursor` query parameter. Returns `undefined` for an absent value and
 * throws an `InvalidParams` fault for a malformed one. Shared by every SSE
 * binding so cursor validation stays defined in exactly one place.
 */
export function readServerSentEventsCursor(value: string | null): Cursor | undefined {
  if (value === null) return undefined;
  if (decodeCursor(value) === null) throw invalidParamsFault('Invalid cursor');
  return value;
}

/** Shapes a fault into the response a Server-Sent Events route answers with. */
export function shapeServerSentEventsFault(
  fault: OperationFault,
  options: Pick<RestFaultResponseOptions, 'isKnownErrorCode'> = {},
): Response {
  if (fault.code === 'InvalidParams' && fault.message === SSE_ACCEPT_REQUIRED_MESSAGE) {
    return shapeRestFaultAsJson(fault, { ...options, status: 406 });
  }
  return shapeRestFaultAsJson(fault, options);
}

/** Format a single Server-Sent Events message. */
export function formatServerSentEvent(event: {
  readonly id?: string;
  readonly event?: string;
  readonly data: string;
}): string {
  const lines: string[] = [];
  if (event.id !== undefined) lines.push(`id: ${event.id}`);
  if (event.event !== undefined) lines.push(`event: ${event.event}`);
  const dataLines = event.data.split('\n');
  for (const line of dataLines) {
    lines.push(`data: ${line}`);
  }
  lines.push('');
  return lines.join('\n') + '\n';
}

function scheduleInterval(callback: () => void, intervalMs: number): () => void {
  const timer = setInterval(callback, intervalMs);
  return () => {
    clearInterval(timer);
  };
}

function encodeFrame(frame: { id?: string; event?: string; data: string }): Uint8Array {
  return textEncoder.encode(formatServerSentEvent(frame));
}

/** What an error frame says of a failure that discloses nothing: the masked internal error. */
const MASKED_FAULT: OperationFault = {
  code: 'EngineFailure',
  message: 'Internal server error',
  data: {},
};

/**
 * The `event: error` frame for a stream that fails after it started: the fault's `code`, `message`
 * and allowlisted `data`, with the `retryable` (always) and `remediation` (when set) every other
 * transport sends. A failure that is not an operation fault, an `EngineFailure`, and a fault whose
 * data JSON cannot carry are the masked internal error, which never carries a remediation.
 */
function sanitizedErrorFrame(error: unknown): { id?: string; event: string; data: string } {
  const fault = isOperationFault(error) ? wireSafeFault(error) : MASKED_FAULT;
  if (fault.code === 'EngineFailure') {
    const { retryable } = faultWireAdvice(MASKED_FAULT);
    return {
      event: 'error',
      data: JSON.stringify({ code: 'EngineFailure', message: MASKED_FAULT.message, retryable }),
    };
  }
  const { retryable, remediation } = faultWireAdvice(fault);
  return {
    event: 'error',
    data: JSON.stringify({
      code: fault.code,
      message: fault.message,
      data: extractFaultDataPayload(fault),
      retryable,
      ...(remediation === undefined ? {} : { remediation }),
    }),
  };
}

function heartbeatOptions(
  options: ServerSentEventHeartbeatOptions | undefined,
): Required<ServerSentEventHeartbeatOptions> {
  return {
    intervalMs: options?.intervalMs ?? DEFAULT_SSE_HEARTBEAT_INTERVAL_MS,
    schedule: options?.schedule ?? scheduleInterval,
    now: options?.now ?? Date.now,
  };
}

/**
 * Convert a replay-plus-live event envelope iterable into an SSE byte stream.
 * Event envelopes advance the client cursor via `id`; heartbeat pings do not.
 */
export function createEventEnvelopeSSEStream<TEnvelope extends ServerSentEventEnvelope>(
  options: EventEnvelopeSSEStreamOptions<TEnvelope>,
): ReadableStream<Uint8Array> {
  let cleanup: (() => Promise<void>) | null = null;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let clearHeartbeat: (() => void) | null = null;
      let clearDeadline: (() => void) | null = null;

      const closeResources = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        if (clearHeartbeat !== null) {
          clearHeartbeat();
          clearHeartbeat = null;
        }
        if (clearDeadline !== null) {
          clearDeadline();
          clearDeadline = null;
        }
        options.signal?.removeEventListener('abort', onAbort);
        try {
          await options.close();
        } catch {
          // A close hook must not throw during response cancellation.
        }
      };
      cleanup = closeResources;

      const enqueue = (frame: { id?: string; event?: string; data: string }): void => {
        if (closed) return;
        try {
          controller.enqueue(encodeFrame(frame));
        } catch {
          void closeResources();
        }
      };

      const onAbort = (): void => {
        void closeResources();
      };
      if (options.signal?.aborted) {
        void closeResources();
        controller.close();
        return;
      }
      options.signal?.addEventListener('abort', onAbort, { once: true });

      const heartbeat = heartbeatOptions(options.heartbeat);
      const enqueuePing = (data: Record<string, unknown>): void => {
        enqueue({
          event: 'ping',
          data: JSON.stringify(data),
        });
      };
      if (options.ready !== undefined) {
        void options.ready.then(
          () => {
            enqueuePing({ emittedAtMs: heartbeat.now(), replayComplete: true });
            return undefined;
          },
          () => undefined,
        );
      }
      if (heartbeat.intervalMs > 0) {
        clearHeartbeat = heartbeat.schedule(() => {
          enqueuePing({ emittedAtMs: heartbeat.now() });
        }, heartbeat.intervalMs);
      }

      if (options.maxDurationMs !== undefined) {
        // The scheduler is interval-shaped, so a second tick is possible
        // before the cleanup cancels it; ending twice is a no-op.
        clearDeadline = heartbeat.schedule(() => {
          // Release the timers and mark the stream closed synchronously, end
          // the response, and only then let the (possibly stalled) close hook
          // run on its own: a hook that never settles must not hold the
          // connection open.
          const released = closeResources();
          try {
            controller.close();
          } catch {
            // The stream may already have ended.
          }
          void released;
        }, options.maxDurationMs);
      }

      void (async () => {
        try {
          for await (const envelope of options.iterable) {
            enqueue({
              id: envelope.cursor,
              event: envelope.kind,
              data: JSON.stringify(envelope),
            });
          }
        } catch (error) {
          enqueue(sanitizedErrorFrame(error));
        } finally {
          await closeResources();
          try {
            controller.close();
          } catch {
            // The client may have already canceled the stream.
          }
        }
      })();
    },
    cancel() {
      return cleanup?.();
    },
  });
}

/**
 * Wrap a list of stored stream chunks as a Server-Sent Events stream. Each
 * chunk gets emitted as a `token` event keyed by `chunk.sequence`; chunks
 * whose mapped text is `null` are skipped. After the chunks, a single
 * `done` event with empty data is emitted and the controller closes.
 *
 * Used by REST `shapeSuccess` for the streaming routes (`streamSSE`,
 * `getStreamChunks` when negotiated to `text/event-stream`).
 */
export function createStoredChunkSSEStream<TChunk extends { readonly sequence: number }>(
  chunks: ReadonlyArray<TChunk>,
  mapChunkToText: (chunk: TChunk) => string | null,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        const text = mapChunkToText(chunk);
        if (text === null) {
          continue;
        }

        controller.enqueue(
          textEncoder.encode(
            formatServerSentEvent({
              id: String(chunk.sequence),
              event: 'token',
              data: text,
            }),
          ),
        );
      }

      controller.enqueue(
        textEncoder.encode(
          formatServerSentEvent({
            event: 'done',
            data: '',
          }),
        ),
      );
      controller.close();
    },
  });
}

/** Standard headers for an SSE response. */
export const SSE_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

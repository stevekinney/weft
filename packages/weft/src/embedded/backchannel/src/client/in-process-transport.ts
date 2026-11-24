import { faultToJsonRpcError } from '../fault-to-json-rpc.ts';
import type { JsonRpcSubscription } from '../json-rpc-dispatch.ts';
import { isPlainObject } from '../json-schema-utilities.ts';
import {
  executeOperation,
  executeSubscription,
  type OperationRegistry,
} from '../operation-catalog.ts';
import type { Principal } from '../principal.ts';
import { CatalogClientError, type CatalogTransport } from './catalog-client.ts';
import type { SubscriptionMessage, SubscriptionTransport } from './subscription-client.ts';

/** The operation catalog, host and caller used to dispatch an embedded client's calls. */
export type InProcessTransportOptions = {
  /** The operation catalog used by the client. */
  readonly registry: OperationRegistry;
  /** The host value or per-dispatch factory. */
  readonly host: unknown;
  /** The local caller for each dispatch. */
  readonly principal: Principal;
  /** Select REST dispatch semantics for operations called through REST by the remote client. */
  readonly restOperationNames?: ReadonlySet<string>;
};

/** Dispatch unary calls in the current process, using the same fault envelope as JSON-RPC. */
export function inProcessCatalogTransport(options: InProcessTransportOptions): CatalogTransport {
  const { host, principal, registry } = options;
  const restOperationNames = new Set(options.restOperationNames);
  return async (operationName, input, callOptions) => {
    const signal = callOptions?.signal;
    signal?.throwIfAborted();
    const result = await executeOperation(operationName, input, {
      principal,
      host,
      registry,
      transport: restOperationNames.has(operationName) ? 'http-rest' : 'jsonRpcHttp',
      ...(signal === undefined ? {} : { signal }),
    });
    signal?.throwIfAborted();
    if (!result.ok) throw new CatalogClientError(operationName, faultToJsonRpcError(result.fault));
    return result.value;
  };
}

/** Follow a catalog subscription in-process with the same cursor convention as SSE. */
export function inProcessSubscriptionTransport(
  options: InProcessTransportOptions,
): SubscriptionTransport {
  const { host, principal, registry } = options;
  return async function* (operationName, input, callOptions) {
    const signal = callOptions?.signal;
    if (isAborted(signal)) return;
    const result = await executeSubscription(
      operationName,
      resumeInput(input, callOptions?.lastEventId),
      {
        host,
        principal,
        registry,
        transport: 'http-rest',
        ...(signal === undefined ? {} : { signal }),
      },
    );
    if (!result.ok) {
      if (!isAborted(signal)) {
        throw new CatalogClientError(operationName, faultToJsonRpcError(result.fault));
      }
      return;
    }
    yield* readSubscription(operationName, result.value, signal);
  };
}

function resumeInput(input: unknown, cursor: string | undefined): unknown {
  return cursor && isPlainObject(input) ? { ...input, fromCursor: cursor } : input;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

async function* readSubscription(
  operationName: string,
  { iterable, replayComplete, close }: JsonRpcSubscription,
  signal: AbortSignal | undefined,
): AsyncGenerator<SubscriptionMessage<unknown>> {
  const iterator = iterable[Symbol.asyncIterator]();
  let closing: Promise<void> | undefined;
  const closeOnce = (): Promise<void> =>
    (closing ??= Promise.resolve()
      .then(close)
      .catch(() => {}));
  const abort = (): void => {
    void closeOnce();
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const read = subscriptionReader(iterator, replayComplete);
    while (!isAborted(signal)) {
      const item = await read();
      if (isAborted(signal)) return;
      if (item.kind === 'ready') yield { type: 'replay-complete' };
      else if (item.result.done) return;
      else yield eventMessage(operationName, item.result.value);
    }
  } catch (error) {
    if (!isAborted(signal)) throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    await closeOnce();
    await returnIterator(iterator);
  }
}

async function returnIterator(iterator: AsyncIterator<unknown>): Promise<void> {
  try {
    await iterator.return?.();
  } catch {
    // The feed has been closed. A cleanup failure cannot replace the original read outcome.
  }
}

type NextItem = { kind: 'ready' } | { kind: 'event'; result: IteratorResult<unknown> };

function subscriptionReader(iterator: AsyncIterator<unknown>, replayComplete?: Promise<void>) {
  let replayReady = false;
  let notifyReady: (() => void) | undefined;
  let pending: Promise<NextItem> | undefined;
  void replayComplete?.then(
    () => {
      replayReady = true;
      notifyReady?.();
      return undefined;
    },
    () => undefined,
  );

  return async (): Promise<NextItem> => {
    if (replayReady) {
      replayReady = false;
      return { kind: 'ready' };
    }
    const next = (pending ??= iterator.next().then((result) => ({ kind: 'event', result })));
    const ready = new Promise<NextItem>((resolve) => {
      notifyReady = () => resolve({ kind: 'ready' });
    });
    try {
      const item = await Promise.race([next, ready]);
      if (item.kind === 'ready') replayReady = false;
      else pending = undefined;
      return item;
    } finally {
      notifyReady = undefined;
    }
  };
}

function eventMessage(operationName: string, data: unknown): SubscriptionMessage<unknown> {
  if (isPlainObject(data) && typeof data['cursor'] === 'string') {
    return { type: 'event', id: data['cursor'], data };
  }
  throw new CatalogClientError(
    operationName,
    faultToJsonRpcError({
      code: 'EngineFailure',
      message: 'internal error',
      data: {},
    }),
  );
}

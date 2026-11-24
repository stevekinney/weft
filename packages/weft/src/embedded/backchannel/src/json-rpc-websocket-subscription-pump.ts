import { JSON_RPC_VERSION } from './json-rpc-protocol.ts';
import {
  createSubscriptionErrorTerminatedFrame,
  SESSION_METHODS,
} from './json-rpc-websocket-subscriptions.ts';

export async function pumpSubscriptionIterable(options: {
  subscriptionId: string;
  iterable: AsyncIterable<unknown>;
  signal: AbortSignal;
  closeSubscription: () => Promise<void>;
  shouldSuppressOutput: () => boolean;
  emit: (message: Record<string, unknown>) => void;
  onComplete: () => void;
}): Promise<void> {
  const {
    subscriptionId,
    iterable,
    signal,
    closeSubscription,
    shouldSuppressOutput,
    emit,
    onComplete,
  } = options;
  let closeStarted = false;
  async function closeOnce(): Promise<void> {
    if (closeStarted) return;
    closeStarted = true;
    await closeSubscription();
  }
  const abortSubscription = (): void => {
    void closeOnce().catch(() => {});
  };
  signal.addEventListener('abort', abortSubscription, { once: true });
  try {
    for await (const envelope of iterable) {
      if (signal.aborted) {
        await closeOnce().catch(() => {});
        break;
      }
      emit({
        jsonrpc: JSON_RPC_VERSION,
        method: SESSION_METHODS.DELIVER,
        params: { subscriptionId, envelope },
      });
    }
    if (!signal.aborted && !shouldSuppressOutput()) {
      emit({
        jsonrpc: JSON_RPC_VERSION,
        method: SESSION_METHODS.TERMINATED,
        params: { subscriptionId, reason: 'server-closed' },
      });
    }
  } catch (error) {
    if (!signal.aborted && !shouldSuppressOutput()) {
      emit(createSubscriptionErrorTerminatedFrame(subscriptionId, error));
    }
  } finally {
    signal.removeEventListener('abort', abortSubscription);
    await closeOnce().catch(() => {});
    onComplete();
  }
}

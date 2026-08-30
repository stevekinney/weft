import type { UpdateRequest } from '../updates.ts';
import type { EngineInternals } from './internals.ts';
import { dispatchPendingUpdateReceived as dispatchPendingUpdateReceivedFromUpdates } from './updates.ts';

export type BroadcastCallbacks = {
  dispatchEvent: (event: Event) => boolean;
};

export function forwardEventToHandle(
  internals: EngineInternals,
  workflowId: string,
  event: Event,
  _callbacks: BroadcastCallbacks,
): void {
  const entry = internals.handleCache.get(workflowId);
  if (!entry) return;
  const handle = entry.ref.deref();
  if (!handle) return;
  // Re-dispatch the typed event so handle listeners receive the full event
  // with all custom properties (workflowId, timeoutType, error, etc.).
  handle.dispatchEvent(event);
}

export function dispatchPendingUpdateReceived(
  internals: EngineInternals,
  workflowId: string,
  updateName: string,
  updateRequest: UpdateRequest,
  callbacks: BroadcastCallbacks,
): void {
  dispatchPendingUpdateReceivedFromUpdates(internals, workflowId, updateName, updateRequest, {
    dispatchEvent: callbacks.dispatchEvent,
  });
}

export function broadcast(
  internals: EngineInternals,
  message: Record<string, unknown>,
  _callbacks: BroadcastCallbacks,
): void {
  if (!internals.options.broadcastEvents) return;

  if (internals.broadcastChannel === null) {
    try {
      internals.broadcastChannel = new BroadcastChannel('weft:events');
    } catch {
      return;
    }
  }
  internals.broadcastChannel.postMessage(message);
}

import { JSON_RPC_VERSION } from './json-rpc-protocol.ts';
import { SubscriptionElementValidationError } from './operation-catalog.ts';
import type { OperationFault } from './operation-fault.ts';
import { isOperationFault } from './operations/operation-helpers.ts';

export const SESSION_METHODS = {
  SUBSCRIBE: 'weft.workflows.subscribe',
  FLEET_SUBSCRIBE: 'weft.events.subscribe',
  UNSUBSCRIBE: 'weft.workflows.unsubscribe',
  DELIVER: 'weft.events.deliver',
  TERMINATED: 'weft.events.terminated',
} as const;

export const WORKFLOW_EVENTS_OPERATION_NAME = 'weft.workflows.events';
export const FLEET_EVENTS_OPERATION_NAME = 'weft.events.subscribe';

const ENGINE_FAILURE_FAULT: OperationFault = {
  code: 'EngineFailure',
  message: 'internal error',
  data: {},
};

export function createSubscriptionErrorTerminatedFrame(
  subscriptionId: string,
  error: unknown,
): Record<string, unknown> {
  if (error instanceof SubscriptionElementValidationError) {
    return createSubscriptionTerminatedFrame(subscriptionId, 'validation-failed', error.fault);
  }
  if (isOperationFault(error)) {
    return createSubscriptionTerminatedFrame(subscriptionId, 'server-closed', error);
  }
  return createSubscriptionTerminatedFrame(subscriptionId, 'server-closed', ENGINE_FAILURE_FAULT);
}

function createSubscriptionTerminatedFrame(
  subscriptionId: string,
  reason: 'server-closed' | 'validation-failed',
  fault: OperationFault,
): Record<string, unknown> {
  return {
    jsonrpc: JSON_RPC_VERSION,
    method: SESSION_METHODS.TERMINATED,
    params: { subscriptionId, reason, fault },
  };
}

import { type ErasedOperation, type OperationRegistry } from './operation-catalog.ts';
import { fleetEventsSubscriptionOperation } from './operations/fleet-events-subscription.ts';
import { workflowEventsSubscriptionOperation } from './operations/workflow-events-subscription.ts';

export const SESSION_METHODS = {
  SUBSCRIBE: 'weft.workflows.subscribe',
  FLEET_SUBSCRIBE: 'weft.events.subscribe',
  UNSUBSCRIBE: 'weft.workflows.unsubscribe',
  DELIVER: 'weft.events.deliver',
  TERMINATED: 'weft.events.terminated',
} as const;

const WORKFLOW_EVENTS_OPERATION_NAME = 'weft.workflows.events';
export const FLEET_EVENTS_OPERATION_NAME = 'weft.events.subscribe';
const WORKFLOW_EVENTS_SUBSCRIPTION_OPERATION =
  workflowEventsSubscriptionOperation as ErasedOperation;
const FLEET_EVENTS_SUBSCRIPTION_OPERATION = fleetEventsSubscriptionOperation as ErasedOperation;

export function withSessionSubscriptionOperations(registry: OperationRegistry): OperationRegistry {
  const hasWorkflowOperation = registry.get(WORKFLOW_EVENTS_OPERATION_NAME) !== undefined;
  const hasFleetOperation = registry.get(FLEET_EVENTS_OPERATION_NAME) !== undefined;
  if (hasWorkflowOperation && hasFleetOperation) return registry;
  return {
    get(name) {
      if (name === WORKFLOW_EVENTS_OPERATION_NAME && !hasWorkflowOperation) {
        return WORKFLOW_EVENTS_SUBSCRIPTION_OPERATION;
      }
      if (name === FLEET_EVENTS_OPERATION_NAME && !hasFleetOperation) {
        return FLEET_EVENTS_SUBSCRIPTION_OPERATION;
      }
      return registry.get(name);
    },
    list() {
      return [
        ...registry.list(),
        ...(hasWorkflowOperation ? [] : [WORKFLOW_EVENTS_SUBSCRIPTION_OPERATION]),
        ...(hasFleetOperation ? [] : [FLEET_EVENTS_SUBSCRIPTION_OPERATION]),
      ];
    },
  };
}

export const SESSION_METHODS = {
  SUBSCRIBE: 'weft.workflows.subscribe',
  FLEET_SUBSCRIBE: 'weft.events.subscribe',
  UNSUBSCRIBE: 'weft.workflows.unsubscribe',
  DELIVER: 'weft.events.deliver',
  TERMINATED: 'weft.events.terminated',
} as const;

export const FLEET_EVENTS_OPERATION_NAME = 'weft.events.subscribe';

import type { WeftAgentEventMap } from '../ai/events.ts';

export class WorkflowStartedEvent extends Event {
  static readonly type = 'workflow:started' as const;
  readonly workflowId: string;
  readonly workflowType: string;
  readonly input: unknown;

  constructor(workflowId: string, workflowType: string, input: unknown) {
    super(WorkflowStartedEvent.type);
    this.workflowId = workflowId;
    this.workflowType = workflowType;
    this.input = input;
  }
}

export class WorkflowCompletedEvent extends Event {
  static readonly type = 'workflow:completed' as const;
  readonly workflowId: string;
  readonly result: unknown;
  readonly duration: number;

  constructor(workflowId: string, result: unknown, duration: number) {
    super(WorkflowCompletedEvent.type);
    this.workflowId = workflowId;
    this.result = result;
    this.duration = duration;
  }
}

export class WorkflowFailedEvent extends Event {
  static readonly type = 'workflow:failed' as const;
  readonly workflowId: string;
  readonly error: Error;

  constructor(workflowId: string, error: Error) {
    super(WorkflowFailedEvent.type);
    this.workflowId = workflowId;
    this.error = error;
  }
}

export class WorkflowCancelledEvent extends Event {
  static readonly type = 'workflow:cancelled' as const;
  readonly workflowId: string;

  constructor(workflowId: string) {
    super(WorkflowCancelledEvent.type);
    this.workflowId = workflowId;
  }
}

export class WorkflowTimedOutEvent extends Event {
  static readonly type = 'workflow:timed-out' as const;
  readonly workflowId: string;
  readonly timeoutType: 'execution' | 'run';
  readonly elapsed: number;

  constructor(workflowId: string, timeoutType: 'execution' | 'run', elapsed: number) {
    super(WorkflowTimedOutEvent.type);
    this.workflowId = workflowId;
    this.timeoutType = timeoutType;
    this.elapsed = elapsed;
  }
}

export class WorkflowResumedEvent extends Event {
  static readonly type = 'workflow:resumed' as const;
  readonly workflowId: string;
  readonly fromStep: number;

  constructor(workflowId: string, fromStep: number) {
    super(WorkflowResumedEvent.type);
    this.workflowId = workflowId;
    this.fromStep = fromStep;
  }
}

export class ActivityStartedEvent extends Event {
  static readonly type = 'activity:started' as const;
  readonly operationId: string;
  readonly workflowId: string;
  readonly activityName: string;
  readonly attempt: number;

  constructor(operationId: string, workflowId: string, activityName: string, attempt: number) {
    super(ActivityStartedEvent.type);
    this.operationId = operationId;
    this.workflowId = workflowId;
    this.activityName = activityName;
    this.attempt = attempt;
  }
}

export class ActivityCompletedEvent extends Event {
  static readonly type = 'activity:completed' as const;
  readonly operationId: string;
  readonly workflowId: string;
  readonly activityName: string;
  readonly duration: number;

  constructor(operationId: string, workflowId: string, activityName: string, duration: number) {
    super(ActivityCompletedEvent.type);
    this.operationId = operationId;
    this.workflowId = workflowId;
    this.activityName = activityName;
    this.duration = duration;
  }
}

export class ActivityFailedEvent extends Event {
  static readonly type = 'activity:failed' as const;
  readonly operationId: string;
  readonly workflowId: string;
  readonly activityName: string;
  readonly error: Error;
  readonly attempt: number;

  constructor(
    operationId: string,
    workflowId: string,
    activityName: string,
    error: Error,
    attempt: number,
  ) {
    super(ActivityFailedEvent.type);
    this.operationId = operationId;
    this.workflowId = workflowId;
    this.activityName = activityName;
    this.error = error;
    this.attempt = attempt;
  }
}

export class TokenEvent extends Event {
  static readonly type = 'agent:token' as const;
  readonly workflowId: string;
  readonly token: string;
  readonly model: string;

  constructor(workflowId: string, token: string, model: string) {
    super(TokenEvent.type);
    this.workflowId = workflowId;
    this.token = token;
    this.model = model;
  }
}

export class SignalReceivedEvent extends Event {
  static readonly type = 'signal:received' as const;
  readonly workflowId: string;
  readonly signalName: string;
  readonly payload: unknown;

  constructor(workflowId: string, signalName: string, payload: unknown) {
    super(SignalReceivedEvent.type);
    this.workflowId = workflowId;
    this.signalName = signalName;
    this.payload = payload;
  }
}

export class SignalDeliveredEvent extends Event {
  static readonly type = 'signal:delivered' as const;
  readonly workflowId: string;
  readonly signalName: string;

  constructor(workflowId: string, signalName: string) {
    super(SignalDeliveredEvent.type);
    this.workflowId = workflowId;
    this.signalName = signalName;
  }
}

export class AttributesChangedEvent extends Event {
  static readonly type = 'attributes:changed' as const;
  readonly workflowId: string;
  readonly changes: Record<string, unknown>;

  constructor(workflowId: string, changes: Record<string, unknown>) {
    super(AttributesChangedEvent.type);
    this.workflowId = workflowId;
    this.changes = changes;
  }
}

export class UpdateReceivedEvent extends Event {
  static readonly type = 'update:received' as const;
  readonly updateId: string;
  readonly workflowId: string;
  readonly name: string;
  readonly payload: unknown;

  constructor(updateId: string, workflowId: string, name: string, payload: unknown) {
    super(UpdateReceivedEvent.type);
    this.updateId = updateId;
    this.workflowId = workflowId;
    this.name = name;
    this.payload = payload;
  }
}

export class UpdateCompletedEvent extends Event {
  static readonly type = 'update:completed' as const;
  readonly updateId: string;
  readonly workflowId: string;
  readonly name: string;
  readonly result: unknown;
  readonly error: string | undefined;

  constructor(updateId: string, workflowId: string, name: string, result: unknown, error?: string) {
    super(UpdateCompletedEvent.type);
    this.updateId = updateId;
    this.workflowId = workflowId;
    this.name = name;
    this.result = result;
    this.error = error;
  }
}

export class CheckpointSizeWarningEvent extends Event {
  static readonly type = 'checkpoint:size-warning' as const;
  readonly workflowId: string;
  readonly sizeBytes: number;
  readonly step: number;

  constructor(workflowId: string, sizeBytes: number, step: number) {
    super(CheckpointSizeWarningEvent.type);
    this.workflowId = workflowId;
    this.sizeBytes = sizeBytes;
    this.step = step;
  }
}

export class DevelopmentWarningEvent extends Event {
  static readonly type = 'development:warning' as const;
  readonly workflowId: string;
  readonly message: string;
  readonly fieldPaths: string[];

  constructor(workflowId: string, message: string, fieldPaths: string[]) {
    super(DevelopmentWarningEvent.type);
    this.workflowId = workflowId;
    this.message = message;
    this.fieldPaths = fieldPaths;
  }
}

export type WeftEventMap = WeftAgentEventMap & {
  'workflow:started': WorkflowStartedEvent;
  'workflow:completed': WorkflowCompletedEvent;
  'workflow:failed': WorkflowFailedEvent;
  'workflow:cancelled': WorkflowCancelledEvent;
  'workflow:timed-out': WorkflowTimedOutEvent;
  'workflow:resumed': WorkflowResumedEvent;
  'activity:started': ActivityStartedEvent;
  'activity:completed': ActivityCompletedEvent;
  'activity:failed': ActivityFailedEvent;
  'agent:token': TokenEvent;
  'signal:received': SignalReceivedEvent;
  'signal:delivered': SignalDeliveredEvent;
  'attributes:changed': AttributesChangedEvent;
  'update:received': UpdateReceivedEvent;
  'update:completed': UpdateCompletedEvent;
  'checkpoint:size-warning': CheckpointSizeWarningEvent;
  'development:warning': DevelopmentWarningEvent;
};

export interface TypedEventTarget<TEventMap extends Record<string, Event>> {
  addEventListener<K extends keyof TEventMap & string>(
    type: K,
    listener: (event: TEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener<K extends keyof TEventMap & string>(
    type: K,
    listener: (event: TEventMap[K]) => void,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;
}

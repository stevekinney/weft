import {
  Engine,
  LeaseHealthChangedEvent,
  QueueDepthChangedEvent,
  RealmStateChangedEvent,
  StreamChunkEvent,
  TaskAttemptTransitionEvent,
  TaskResultDeadLetteredEvent,
  WorkerDeploymentChangedEvent,
  WorkerRegistrationRejectedEvent,
  WorkflowRevisionActivatedEvent,
  WorkflowRevisionActivationRejectedEvent,
  WorkflowRevisionDrainingEvent,
  WorkflowRevisionInstalledEvent,
  WorkflowRevisionRemovedEvent,
  type LeaseHealthStatus,
  type WorkerDeploymentDrainState,
  type WorkerExecutionIdentity,
} from '../index.ts';

const eventType: 'task:dead-lettered' = TaskResultDeadLetteredEvent.type;
void eventType;

const engine = new Engine();
engine.addEventListener(TaskResultDeadLetteredEvent.type, (event) => {
  const operationId: string = event.operationId;
  void operationId;
});

// COR-205 acceptance criterion 14: server operations, generated clients, and
// workflow events share one provenance type. `TaskAttemptTransitionEvent`'s
// `executionIdentity` must be the SAME `WorkerExecutionIdentity` type
// `TaskAttemptRecord` and `weft.tasks.get`'s `attempts[]` already carry, not
// a second, independently-drifting shape — this assignment fails to compile
// if it were.
engine.addEventListener(TaskAttemptTransitionEvent.type, (event) => {
  const narrowed: TaskAttemptTransitionEvent = event;
  const executionIdentity: WorkerExecutionIdentity | undefined = narrowed.executionIdentity;
  const previousExecutionIdentity: WorkerExecutionIdentity | undefined =
    narrowed.previousExecutionIdentity;
  const crossBuildRetry: boolean = narrowed.crossBuildRetry;
  void executionIdentity;
  void previousExecutionIdentity;
  void crossBuildRetry;
});

engine.addEventListener('catalog:revision-installed', (event) => {
  const narrowed: WorkflowRevisionInstalledEvent = event;
  const revision: string = narrowed.revision;
  void revision;
});

engine.addEventListener('catalog:revision-activated', (event) => {
  const narrowed: WorkflowRevisionActivatedEvent = event;
  const previousRevision: string | undefined = narrowed.previousRevision;
  void previousRevision;
});

engine.addEventListener('catalog:activation-rejected', (event) => {
  const narrowed: WorkflowRevisionActivationRejectedEvent = event;
  const reason: 'incompatible' | 'stale-generation' | 'conflict' | 'expected-generation-required' =
    narrowed.reason;
  void reason;
});

engine.addEventListener('catalog:revision-draining', (event) => {
  const narrowed: WorkflowRevisionDrainingEvent = event;
  const revision: string = narrowed.revision;
  void revision;
});

engine.addEventListener('catalog:revision-removed', (event) => {
  const narrowed: WorkflowRevisionRemovedEvent = event;
  const revision: string = narrowed.revision;
  void revision;
});

engine.addEventListener('realm:state-changed', (event) => {
  const narrowed: RealmStateChangedEvent = event;
  const state: 'warming' | 'ready' | 'active' | 'draining' | 'terminated' | 'crashed' =
    narrowed.state;
  const restartCount: number = narrowed.restartCount;
  void state;
  void restartCount;
});

engine.addEventListener('lease:health-changed', (event) => {
  const narrowed: LeaseHealthChangedEvent = event;
  const status: LeaseHealthStatus = narrowed.status;
  void status;
});

engine.addEventListener('worker:registration-rejected', (event) => {
  const narrowed: WorkerRegistrationRejectedEvent = event;
  const workerId: string | undefined = narrowed.workerId;
  void workerId;
});

engine.addEventListener('worker:deployment-changed', (event) => {
  const narrowed: WorkerDeploymentChangedEvent = event;
  const drainState: WorkerDeploymentDrainState = narrowed.drainState;
  const routingGeneration: number = narrowed.routingGeneration;
  void drainState;
  void routingGeneration;
});

engine.addEventListener('stream:chunk', (event) => {
  const narrowed: StreamChunkEvent = event;
  const key: string = narrowed.key;
  const sequence: number = narrowed.sequence;
  void key;
  void sequence;
});

engine.addEventListener('queue:depth-changed', (event) => {
  const narrowed: QueueDepthChangedEvent = event;
  const queue: string = narrowed.queue;
  const depth: number = narrowed.depth;
  void queue;
  void depth;
});

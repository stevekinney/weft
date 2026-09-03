import {
  Engine,
  TaskResultDeadLetteredEvent,
  WorkflowRevisionActivatedEvent,
  WorkflowRevisionActivationRejectedEvent,
  WorkflowRevisionDrainingEvent,
  WorkflowRevisionInstalledEvent,
  WorkflowRevisionRemovedEvent,
} from '../index.ts';

const eventType: 'task:dead-lettered' = TaskResultDeadLetteredEvent.type;
void eventType;

const engine = new Engine();
engine.addEventListener(TaskResultDeadLetteredEvent.type, (event) => {
  const operationId: string = event.operationId;
  void operationId;
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
  const reason: 'incompatible' | 'stale-generation' | 'conflict' = narrowed.reason;
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

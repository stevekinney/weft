import { Engine, TaskResultDeadLetteredEvent } from '../index.ts';

const eventType: 'task:dead-lettered' = TaskResultDeadLetteredEvent.type;
void eventType;

const engine = new Engine();
engine.addEventListener(TaskResultDeadLetteredEvent.type, (event) => {
  const operationId: string = event.operationId;
  void operationId;
});

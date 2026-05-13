import { WorkflowHandleDelegation } from './handle-delegation.ts';
import { HttpHandle } from './http-handle.ts';

declare const delegatedHandle: WorkflowHandleDelegation;
declare const httpHandle: HttpHandle;

delegatedHandle.addEventListener('workflow:completed', (event) => {
  const result: unknown = event.result;
  void result;
});

httpHandle.addEventListener('workflow:completed', (event) => {
  const result: unknown = event.result;
  void result;
});

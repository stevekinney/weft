import { z } from 'zod';

import { taskAttemptPrefix } from '../../core/task-ledger/task-attempt.ts';
import { commitTaskLedgerDelete } from '../../core/task-ledger/task-ledger-runtime.ts';
import { canClearDeadLetteredTask } from '../../core/task-ledger/task-ledger-transitions.ts';
import { raiseFault } from '../operation-catalog/raise-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { requireOperationStorage } from './operation-helpers.ts';

const clearTaskDeadLetterInput = z.object({ operationId: z.string().min(1) });
const okOutput = z.object({ ok: z.literal(true) }).strict();

export type ClearTaskDeadLetterInput = z.infer<typeof clearTaskDeadLetterInput>;
export type ClearTaskDeadLetterOutput = z.infer<typeof okOutput>;

const restOnlyTaskDiagnosticsTransports = {
  http: true,
  jsonRpcHttp: false,
  jsonRpcWebSocket: false,
  jsonRpcStdio: false,
} as const;

export const clearTaskDeadLetterOperation = defineOperation({
  name: 'weft.tasks.diagnostics.deadletters.clear',
  mcpExposable: false,
  summary: 'Clear a task-result dead-letter diagnostic entry',
  destructive: true,
  tags: ['Observability'],
  inputSchema: clearTaskDeadLetterInput,
  outputSchema: okOutput,
  access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['system:admin'] } },
  producibleFaults: ['NotFound'],
  discoverable: true,
  transports: restOnlyTaskDiagnosticsTransports,
  unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
  invoke: async ({ input, engine }): Promise<ClearTaskDeadLetterOutput> => {
    const storage = requireOperationStorage(engine, ['get', 'scan']);
    // Acceptance criterion 12: clearing a dead-lettered diagnostic removes
    // its attempt history in the same bounded, atomic operation — the same
    // reasoning as `reapRetainedTerminalRecord`'s retention purge
    // (`task-reconciliation.ts`).
    const attemptKeys: string[] = [];
    for await (const [attemptKey] of storage.scan(taskAttemptPrefix(input.operationId))) {
      attemptKeys.push(attemptKey);
    }
    const deleted = await commitTaskLedgerDelete(
      storage,
      input.operationId,
      canClearDeadLetteredTask,
      1,
      attemptKeys,
    );
    if (!deleted.ok) {
      raiseFault(clearTaskDeadLetterOperation, {
        code: 'NotFound',
        message: `No dead-lettered task found for operation "${input.operationId}"`,
        data: { resource: 'task', identifier: input.operationId },
      });
    }
    return { ok: true };
  },
});

export const clearTaskDeadLetterRestBinding: UnknownRestBinding = {
  method: 'DELETE',
  path: '/v1/tasks/diagnostics/dead-letter/:operationId',
  pathParamNames: ['operationId'],
  operationName: 'weft.tasks.diagnostics.deadletters.clear',
  inputSources: { operationId: { kind: 'path', pathParam: 'operationId' } },
  extractInput: async (_request, pathParams) => ({ operationId: pathParams['operationId'] ?? '' }),
  success: { kind: 'json', status: 200 },
};

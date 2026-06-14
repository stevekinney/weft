import type { ContextOperationRequest } from '../context.ts';
import type { EngineInternals } from './internals.ts';
import { completeOperation, type OperationRouterCallbacks } from './operations-router.ts';

type GetVersionOperation = Extract<ContextOperationRequest, { type: 'get-version' }>;

export async function processGetVersionOperation(
  internals: EngineInternals,
  workflowId: string,
  operation: GetVersionOperation,
  callbacks: Pick<OperationRouterCallbacks, 'finalizePendingTimelineEntry' | 'feedOperationResult'>,
): Promise<void> {
  completeOperation(internals, workflowId, operation.version, callbacks);
}

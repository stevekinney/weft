import type { Engine } from '../core/engine.ts';
import type { ListFilter, PaginatedResult, WorkflowState, WorkflowSummary } from '../core/types.ts';
import { WeftError } from '../core/weft-error.ts';
import type { AuthorizationScope } from '../server/authorization-scope.ts';
import { isAuthenticated, type Principal } from '../server/principal.ts';

/** Execution context shared by MCP tools and resources. */
export type McpAccessContext = {
  readonly engine: Engine;
  readonly principal: Principal;
  readonly authRequired: boolean;
};

/** Error surfaced as a tool-level failure rather than a protocol failure. */
export class McpToolExecutionError extends WeftError<'McpToolExecutionError'> {
  constructor(message: string) {
    super('McpToolExecutionError', message);
  }
}

/** Assert that the principal has a scope when authentication is enabled. */
export function assertScope(
  context: McpAccessContext,
  scope: AuthorizationScope,
  action: string,
): void {
  if (!context.authRequired) return;
  if (!isAuthenticated(context.principal)) {
    throw new McpToolExecutionError(`${action} requires authentication`);
  }
  if (!context.principal.hasScope(scope)) {
    throw new McpToolExecutionError(`${action} requires ${scope}`);
  }
}

/** Load a workflow by id. */
export async function getVisibleWorkflowState(
  engine: Engine,
  workflowId: string,
): Promise<WorkflowState | null> {
  return engine.get(workflowId);
}

/** List workflows. */
export async function listVisibleWorkflows(
  engine: Engine,
  filter?: ListFilter,
): Promise<PaginatedResult<WorkflowSummary>> {
  return engine.list(filter);
}

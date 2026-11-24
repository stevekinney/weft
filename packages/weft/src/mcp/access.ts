import { type AuthorizationScope, type FaultCode, type Principal } from "../embedded/backchannel/src/index.ts";
import { isAuthenticated } from "../embedded/backchannel/src/internals.ts";
import type { Engine } from '../core/engine.ts';
import type { ListFilter, PaginatedResult, WorkflowState, WorkflowSummary } from '../core/types.ts';
import { WeftError } from '../core/weft-error.ts';

/** Execution context shared by MCP tools and resources. */
export type McpAccessContext = {
  readonly engine: Engine;
  readonly principal: Principal;
  readonly authRequired: boolean;
};

/** What a tool failure tells the caller beyond its message: the fault code and the next step. */
type McpToolFaultOptions = {
  /** The fault code the tool result reports; `InvalidParams` when omitted. */
  readonly faultCode?: FaultCode;
  /** One line saying what the caller can do next (see `assertValidRemediation`). */
  readonly remediation?: string;
};

/**
 * Error surfaced as a tool-level failure rather than a protocol failure. The tool result reports
 * its `faultCode` (default `InvalidParams`, a refused argument) and `remediation` as structured
 * content.
 */
export class McpToolExecutionError extends WeftError<'McpToolExecutionError'> {
  readonly faultCode: FaultCode;
  readonly remediation: string | undefined;

  constructor(message: string, options: McpToolFaultOptions = {}) {
    super('McpToolExecutionError', message);
    this.faultCode = options.faultCode ?? 'InvalidParams';
    this.remediation = options.remediation;
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
    throw new McpToolExecutionError(`${action} requires authentication`, {
      faultCode: 'Unauthorized',
      remediation: 'Authenticate the MCP connection, then call the tool again',
    });
  }
  if (!context.principal.hasScope(scope)) {
    throw new McpToolExecutionError(`${action} requires ${scope}`, {
      faultCode: 'Forbidden',
      remediation: `Connect with a credential that has the ${scope} scope`,
    });
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

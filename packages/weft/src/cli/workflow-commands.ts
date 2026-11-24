/**
 * `weft workflow ls|get|events|start|cancel|signal` — the human-facing inspect
 * and operate surface for workflows on a running server.
 *
 * Every action routes through the generated typed client via
 * {@link callCatalogOperation}; the commands never build HTTP requests
 * directly. Output follows the shared DX conventions: a human table or summary
 * on a TTY, NDJSON (lists) or a single JSON object (`--json`) for machines, and
 * a confirmation gate before the destructive `cancel`.
 *
 * @module cli/workflow-commands
 */

import type { ConnectionOptions } from '../index.ts';
import { cliFault, renderFault, type CliFault } from './cli-fault.ts';
import { loadJsonInput } from './json-input.ts';
import {
  confirmDestructive,
  formatTimestamp,
  ndjson,
  prettyJson,
  truncateToWidth,
} from './output.ts';
import { NOT_FOUND_EXIT_CODE, callCatalogOperation, failureExitCode } from './server-client.ts';
import type { CommandOutput, WorkflowCommand } from './types.ts';

type WorkflowSummaryRow = {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly createdAt: number;
  readonly updatedAt: number;
};

/** Execute any `weft workflow <action>` command against a server. */
export async function executeWorkflow(command: WorkflowCommand): Promise<CommandOutput> {
  const connection: ConnectionOptions = {
    ...(command.server === undefined ? {} : { server: command.server }),
    ...(command.token === undefined ? {} : { token: command.token }),
    ...(command.profile === undefined ? {} : { profile: command.profile }),
  };

  switch (command.action) {
    case 'ls':
      return executeWorkflowList(command, connection);
    case 'get':
      return executeWorkflowGet(command, connection);
    case 'events':
      return executeWorkflowEvents(command, connection);
    case 'start':
      return executeWorkflowStart(command, connection);
    case 'cancel':
      return executeWorkflowCancel(command, connection);
    case 'signal':
      return executeWorkflowSignal(command, connection);
    default: {
      const exhaustiveCheck: never = command;
      throw new Error(`Unknown workflow command action: ${JSON.stringify(exhaustiveCheck)}`);
    }
  }
}

type GetOrEventsCommand = Extract<WorkflowCommand, { action: 'get' | 'events' }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toSummaryRow(value: unknown): WorkflowSummaryRow | undefined {
  if (!isRecord(value)) return undefined;
  const { id, type, status, createdAt, updatedAt } = value;
  if (typeof id !== 'string' || typeof type !== 'string' || typeof status !== 'string') {
    return undefined;
  }
  return {
    id,
    type,
    status,
    createdAt: typeof createdAt === 'number' ? createdAt : Number.NaN,
    updatedAt: typeof updatedAt === 'number' ? updatedAt : Number.NaN,
  };
}

function extractItems(output: unknown): unknown[] {
  if (isRecord(output) && Array.isArray(output['items'])) return output['items'];
  return [];
}

async function executeWorkflowList(
  command: Extract<WorkflowCommand, { action: 'ls' }>,
  connection: ConnectionOptions,
): Promise<CommandOutput> {
  const result = await callCatalogOperation(connection, 'weft.workflows.list', {
    ...(command.type === undefined ? {} : { type: command.type }),
    ...(command.status === undefined ? {} : { status: command.status }),
    ...(command.failedStep === undefined ? {} : { failedStep: command.failedStep }),
    ...(command.retrying === true ? { retrying: true } : {}),
    ...(command.limit === undefined ? {} : { limit: command.limit }),
  });
  if (!result.ok) return failure(result, command.json);

  const items = extractItems(result.value);

  if (command.json) {
    return { stdout: ndjson(items), exitCode: 0 };
  }
  if (command.quiet) {
    const ids = items
      .map(toSummaryRow)
      .filter((row): row is WorkflowSummaryRow => row !== undefined)
      .map((row) => row.id);
    return { stdout: ids.join('\n'), exitCode: 0 };
  }

  const rows = items
    .map(toSummaryRow)
    .filter((row): row is WorkflowSummaryRow => row !== undefined);
  if (rows.length === 0) return { stdout: 'No workflows found.', exitCode: 0 };

  const table = [
    // Pad each header cell to match the corresponding data column width so
    // the header aligns with the data rows.
    ['ID'.padEnd(36), 'TYPE'.padEnd(20), 'STATUS'.padEnd(12), 'CREATED'].join('  '),
    ...rows.map((row) =>
      [
        truncateToWidth(row.id, 36).padEnd(36),
        truncateToWidth(row.type, 20).padEnd(20),
        row.status.padEnd(12),
        formatTimestamp(row.createdAt),
      ].join('  '),
    ),
  ];
  return { stdout: table.join('\n'), exitCode: 0 };
}

async function executeWorkflowGet(
  command: GetOrEventsCommand,
  connection: ConnectionOptions,
): Promise<CommandOutput> {
  const result = await callCatalogOperation(connection, 'weft.workflows.get', {
    workflowId: command.workflowId,
  });
  if (!result.ok) return failure(result, command.json);
  return { stdout: prettyJson(result.value), exitCode: 0 };
}

async function executeWorkflowEvents(
  command: GetOrEventsCommand,
  connection: ConnectionOptions,
): Promise<CommandOutput> {
  const result = await callCatalogOperation(connection, 'weft.workflows.events.list', {
    workflowId: command.workflowId,
  });
  if (!result.ok) return failure(result, command.json);

  const events = Array.isArray(result.value)
    ? result.value
    : isRecord(result.value) && Array.isArray(result.value['events'])
      ? result.value['events']
      : extractItems(result.value);

  if (command.json) return { stdout: ndjson(events), exitCode: 0 };
  if (events.length === 0) return { stdout: 'No events found.', exitCode: 0 };

  const lines = events.map((event) => {
    if (!isRecord(event)) return JSON.stringify(event);
    const type = typeof event['type'] === 'string' ? event['type'] : 'event';
    const timestamp = formatTimestamp(event['timestamp']);
    return `${timestamp}  ${type}`;
  });
  return { stdout: lines.join('\n'), exitCode: 0 };
}

async function executeWorkflowStart(
  command: Extract<WorkflowCommand, { action: 'start' }>,
  connection: ConnectionOptions,
): Promise<CommandOutput> {
  const parsed = await loadJsonInput(command.input, command.inputFile);
  if (!parsed.ok) return inputFailure('workflow start', parsed.error.message, command.json);

  const result = await callCatalogOperation(connection, 'weft.workflows.start', {
    type: command.workflowType,
    ...(parsed.value === undefined ? {} : { input: parsed.value }),
    ...(command.id === undefined ? {} : { id: command.id }),
  });
  if (!result.ok) return failure(result, command.json);

  if (command.json) return { stdout: prettyJson(result.value), exitCode: 0 };
  const id =
    isRecord(result.value) && typeof result.value['id'] === 'string'
      ? result.value['id']
      : (command.id ?? '');
  return { stdout: command.quiet ? id : `Started workflow ${id}`, exitCode: 0 };
}

async function executeWorkflowCancel(
  command: Extract<WorkflowCommand, { action: 'cancel' }>,
  connection: ConnectionOptions,
): Promise<CommandOutput> {
  if (command.dryRun) return executeWorkflowCancelDryRun(command, connection);

  const decision = await confirmDestructive({
    prompt: `Cancel workflow ${command.workflowId}?`,
    assumeYes: command.yes,
  });
  if (decision === 'non-interactive') {
    return renderFault(
      cliFault(
        'InvalidParams',
        `workflow cancel: refusing to cancel ${command.workflowId} without confirmation`,
        'Pass --yes to proceed in a non-interactive shell',
      ),
      { json: command.json, exitCode: 1 },
    );
  }
  if (decision === 'denied') {
    // The operator declined the prompt: the text output is the answer, and `--json` reports it as
    // a `Conflict` (the request contradicts what the operator just said), the closest code.
    return command.json
      ? renderFault(cliFault('Conflict', 'Cancelled (no action taken).'), {
          json: true,
          exitCode: 1,
        })
      : { stdout: 'Cancelled (no action taken).', exitCode: 1 };
  }

  const result = await callCatalogOperation(connection, 'weft.workflows.cancel', {
    workflowId: command.workflowId,
  });
  if (!result.ok) return failure(result, command.json);

  if (command.json) return { stdout: prettyJson(result.value), exitCode: 0 };
  return {
    stdout: command.quiet ? '' : `Cancelled workflow ${command.workflowId}`,
    exitCode: 0,
  };
}

/**
 * `weft workflow cancel <id> --dry-run`: asks the server what a cancel would do (the run's status,
 * and whether it can be cancelled) and prints the answer. Nothing is cancelled and no confirmation
 * is asked for. An id the server has no run for exits with {@link NOT_FOUND_EXIT_CODE}.
 */
async function executeWorkflowCancelDryRun(
  command: Extract<WorkflowCommand, { action: 'cancel' }>,
  connection: ConnectionOptions,
): Promise<CommandOutput> {
  const result = await callCatalogOperation(connection, 'weft.workflows.cancel', {
    workflowId: command.workflowId,
    dryRun: true,
  });
  if (!result.ok) {
    return result.kind === 'operation' && result.notFound === true
      ? renderFault(result, { json: command.json, exitCode: NOT_FOUND_EXIT_CODE })
      : failure(result, command.json);
  }

  if (command.json) return { stdout: prettyJson(result.value), exitCode: 0 };
  const answer: unknown = result.value;
  if (!isRecord(answer) || typeof answer['status'] !== 'string') {
    return renderFault(
      cliFault(
        'EngineFailure',
        'workflow cancel: the server answered the dry run with an unexpected shape',
        "Run 'weft server info' to compare the server's version with this CLI's",
      ),
      { json: false, exitCode: 1 },
    );
  }
  const status = answer['status'];
  const stdout =
    answer['cancellable'] === true
      ? `Would cancel workflow ${command.workflowId} (status: ${status})`
      : `Cannot cancel workflow ${command.workflowId}: it is already ${status}`;
  return { stdout, exitCode: 0 };
}

async function executeWorkflowSignal(
  command: Extract<WorkflowCommand, { action: 'signal' }>,
  connection: ConnectionOptions,
): Promise<CommandOutput> {
  const parsed = await loadJsonInput(command.input, command.inputFile);
  if (!parsed.ok) return inputFailure('workflow signal', parsed.error.message, command.json);

  const result = await callCatalogOperation(connection, 'weft.workflows.signal', {
    workflowId: command.workflowId,
    signalName: command.signalName,
    ...(parsed.value === undefined ? {} : { payload: parsed.value }),
  });
  if (!result.ok) return failure(result, command.json);

  if (command.json) return { stdout: prettyJson(result.value), exitCode: 0 };
  return {
    stdout: command.quiet ? '' : `Signalled ${command.signalName} to ${command.workflowId}`,
    exitCode: 0,
  };
}

/** An input the command could not read (`--input`, `--input-file`): a usage error, exit code 3. */
function inputFailure(commandName: string, message: string, json: boolean): CommandOutput {
  return renderFault(
    cliFault(
      'InvalidParams',
      `${commandName}: ${message}`,
      'Pass valid JSON with --input, or a readable file (or - for stdin) with --input-file',
    ),
    { json, exitCode: 3 },
  );
}

/**
 * A failed catalog call as command output: the fault the server (or the CLI) reported, with the
 * exit code of its kind. With `--json` it is `{ ok: false, error }` on stdout; otherwise the
 * message and a `Try:` line on stderr.
 */
function failure(
  result: CliFault & { readonly kind: 'connection' | 'compat' | 'operation' },
  json: boolean,
): CommandOutput {
  return renderFault(result, { json, exitCode: failureExitCode(result.kind) });
}

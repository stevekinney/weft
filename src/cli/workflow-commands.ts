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

import type { CliConnectionOptions } from './connection.ts';
import {
  confirmDestructive,
  formatTimestamp,
  ndjson,
  prettyJson,
  truncateToWidth,
} from './output.ts';
import { callCatalogOperation, failureExitCode } from './server-client.ts';
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
  const connection: CliConnectionOptions = {
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
  connection: CliConnectionOptions,
): Promise<CommandOutput> {
  const result = await callCatalogOperation(connection, 'weft.workflows.list', {
    ...(command.type === undefined ? {} : { type: command.type }),
    ...(command.status === undefined ? {} : { status: command.status }),
    ...(command.limit === undefined ? {} : { limit: command.limit }),
  });
  if (!result.ok) return failure(result);

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

  const header = ['ID', 'TYPE', 'STATUS', 'CREATED'];
  const table = [
    header.join('  '),
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
  connection: CliConnectionOptions,
): Promise<CommandOutput> {
  const result = await callCatalogOperation(connection, 'weft.workflows.get', {
    workflowId: command.workflowId,
  });
  if (!result.ok) return failure(result);
  return { stdout: prettyJson(result.value), exitCode: 0 };
}

async function executeWorkflowEvents(
  command: GetOrEventsCommand,
  connection: CliConnectionOptions,
): Promise<CommandOutput> {
  const result = await callCatalogOperation(connection, 'weft.workflows.events.list', {
    workflowId: command.workflowId,
  });
  if (!result.ok) return failure(result);

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

async function readInlineInput(
  input: string | undefined,
  inputFile: string | undefined,
): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
  if (input !== undefined) return parseJson(input);
  if (inputFile !== undefined) {
    if (inputFile === '-') return parseJson(await Bun.stdin.text());
    const file = Bun.file(inputFile);
    if (!(await file.exists())) return { ok: false, message: `input file not found: ${inputFile}` };
    return parseJson(await file.text());
  }
  return { ok: true, value: undefined };
}

function parseJson(source: string): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, value: JSON.parse(source) as unknown };
  } catch (error) {
    return { ok: false, message: `invalid JSON input: ${messageOf(error)}` };
  }
}

async function executeWorkflowStart(
  command: Extract<WorkflowCommand, { action: 'start' }>,
  connection: CliConnectionOptions,
): Promise<CommandOutput> {
  const parsed = await readInlineInput(command.input, command.inputFile);
  if (!parsed.ok) {
    return { stdout: '', stderr: `workflow start: ${parsed.message}`, exitCode: 3 };
  }

  const result = await callCatalogOperation(connection, 'weft.workflows.start', {
    type: command.workflowType,
    ...(parsed.value === undefined ? {} : { input: parsed.value }),
    ...(command.id === undefined ? {} : { id: command.id }),
  });
  if (!result.ok) return failure(result);

  if (command.json) return { stdout: prettyJson(result.value), exitCode: 0 };
  const id =
    isRecord(result.value) && typeof result.value['id'] === 'string'
      ? result.value['id']
      : (command.id ?? '');
  return { stdout: command.quiet ? id : `Started workflow ${id}`, exitCode: 0 };
}

async function executeWorkflowCancel(
  command: Extract<WorkflowCommand, { action: 'cancel' }>,
  connection: CliConnectionOptions,
): Promise<CommandOutput> {
  if (command.dryRun) {
    const stdout = command.json
      ? prettyJson({ affected: 1, workflowId: command.workflowId })
      : `Would cancel 1 workflow: ${command.workflowId}`;
    return { stdout, exitCode: 0 };
  }

  const decision = await confirmDestructive({
    prompt: `Cancel workflow ${command.workflowId}?`,
    assumeYes: command.yes,
  });
  if (decision === 'non-interactive') {
    return {
      stdout: '',
      stderr: `workflow cancel: refusing to cancel ${command.workflowId} without confirmation; pass --yes to proceed in a non-interactive shell`,
      exitCode: 1,
    };
  }
  if (decision === 'denied') {
    return { stdout: 'Cancelled (no action taken).', exitCode: 1 };
  }

  const result = await callCatalogOperation(connection, 'weft.workflows.cancel', {
    workflowId: command.workflowId,
  });
  if (!result.ok) return failure(result);

  if (command.json) return { stdout: prettyJson(result.value), exitCode: 0 };
  return {
    stdout: command.quiet ? '' : `Cancelled workflow ${command.workflowId}`,
    exitCode: 0,
  };
}

async function executeWorkflowSignal(
  command: Extract<WorkflowCommand, { action: 'signal' }>,
  connection: CliConnectionOptions,
): Promise<CommandOutput> {
  const parsed = await readInlineInput(command.input, command.inputFile);
  if (!parsed.ok) {
    return { stdout: '', stderr: `workflow signal: ${parsed.message}`, exitCode: 3 };
  }

  const result = await callCatalogOperation(connection, 'weft.workflows.signal', {
    workflowId: command.workflowId,
    signalName: command.signalName,
    ...(parsed.value === undefined ? {} : { payload: parsed.value }),
  });
  if (!result.ok) return failure(result);

  if (command.json) return { stdout: prettyJson(result.value), exitCode: 0 };
  return {
    stdout: command.quiet ? '' : `Signalled ${command.signalName} to ${command.workflowId}`,
    exitCode: 0,
  };
}

function failure(result: {
  readonly ok: false;
  readonly kind: 'connection' | 'compat' | 'operation';
  readonly message: string;
}): CommandOutput {
  const prefix = result.kind === 'connection' ? 'connection failed: ' : '';
  return {
    stdout: '',
    stderr: `${prefix}${result.message}`,
    exitCode: failureExitCode(result.kind),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

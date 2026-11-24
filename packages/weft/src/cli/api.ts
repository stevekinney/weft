import type { CatalogAccessSnapshot, CatalogOperationSnapshot } from "../embedded/backchannel/src/index.ts";
import type { ErasedOperation } from "../embedded/backchannel/src/internals.ts";
import { sendJsonRpcRequest } from '../client/json-rpc-request.ts';
import { createCatalogSnapshot, createLiveOperationRegistry } from '../index.ts';
import { findNearestCandidate } from './command-suggestions.ts';
import { loadJsonInput } from './json-input.ts';
import type { CliCommand, CommandOutput } from './types.ts';

type ApiCommand = Extract<CliCommand, { command: 'api' }>;

const snapshot = createCatalogSnapshot();
const operationByName = new Map(
  snapshot.operations.map((operation) => [operation.name, operation]),
);

export async function executeApi(command: ApiCommand): Promise<CommandOutput> {
  if (command.list) return listOperations(command);
  if (command.describe !== undefined) return describeOperation(command.describe, command.json);
  const operationResult = resolveInvokableOperation(command);
  if (!operationResult.ok) return operationResult.output;
  const operation = operationResult.operation;

  const inputResult = await readInput(command);
  if (!inputResult.ok) return inputResult.output;

  // `--dry-run` sets `dryRun: true` on the input, over a `dryRun` the input itself carries.
  const input =
    command.dryRun && isRecord(inputResult.value)
      ? { ...inputResult.value, dryRun: true }
      : inputResult.value;
  const validation = validateInput(operationResult.liveOperation, input);
  if (!validation.ok) return validation.output;

  return callOperation(command, operation.name, validation.value);
}

function resolveInvokableOperation(
  command: ApiCommand,
):
  | { ok: true; operation: CatalogOperationSnapshot; liveOperation: ErasedOperation }
  | { ok: false; output: CommandOutput } {
  if (command.operationName === undefined) {
    return {
      ok: false,
      output: usageError('api: expected --list, --describe <operation-name>, or an operation name'),
    };
  }

  // The catalog snapshot and the live registry describe the same operations (a test pins that),
  // so a name found in the snapshot is found in the registry too. Resolving both here makes
  // either lookup missing the same "unknown operation" usage error.
  const operation = operationByName.get(command.operationName);
  const liveOperation = createLiveOperationRegistry().get(command.operationName);
  if (operation === undefined || liveOperation === undefined)
    return { ok: false, output: usageError(formatUnknownOperation(command.operationName)) };
  if (command.dryRun && !inputAcceptsDryRun(liveOperation)) {
    return {
      ok: false,
      output: usageError(
        `api: ${command.operationName} does not support --dry-run: its input has no dryRun field`,
      ),
    };
  }
  // A dry run changes nothing, so a destructive operation needs no `--yes` to be previewed.
  const invokable = assertInvokableOperation(operation, command.yes || command.dryRun === true);
  return invokable.ok ? { ...invokable, liveOperation } : invokable;
}

/** Whether the operation's input schema is an object with a `dryRun` field. */
function inputAcceptsDryRun(operation: ErasedOperation): boolean {
  const shape: unknown = Reflect.get(operation.inputSchema, 'shape');
  return typeof shape === 'object' && shape !== null && Object.hasOwn(shape, 'dryRun');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertInvokableOperation(
  operation: CatalogOperationSnapshot,
  confirmed: boolean,
): { ok: true; operation: CatalogOperationSnapshot } | { ok: false; output: CommandOutput } {
  if (operation.kind !== 'unary') {
    return {
      ok: false,
      output: usageError(
        `api: ${operation.name} is ${operation.kind}; flat invocation supports unary operations only`,
      ),
    };
  }
  if (!operation.transports.jsonRpcHttp) {
    return {
      ok: false,
      output: usageError(`api: ${operation.name} is not available over JSON-RPC HTTP`),
    };
  }
  if (operation.destructive && !confirmed) {
    return {
      ok: false,
      output: {
        stdout: '',
        stderr: `api: ${operation.name} is destructive; pass --yes to confirm execution`,
        exitCode: 1,
      },
    };
  }
  return { ok: true, operation };
}

function listOperations(command: ApiCommand): CommandOutput {
  const operations = snapshot.operations.map((operation) => ({
    name: operation.name,
    kind: operation.kind,
    scope: formatAccess(operation.access),
    transport: operation.transports.jsonRpcHttp ? 'json-rpc-http' : 'unsupported',
    destructive: operation.destructive,
    summary: operation.summary,
  }));

  if (command.json) {
    return { stdout: JSON.stringify({ operations }, null, 2), exitCode: 0 };
  }

  const rows = operations.map((operation) =>
    [
      operation.name.padEnd(38),
      operation.kind.padEnd(12),
      operation.scope.padEnd(24),
      operation.transport.padEnd(14),
      operation.destructive ? 'destructive' : 'safe',
      operation.summary,
    ].join('  '),
  );
  return {
    stdout: [
      'name'.padEnd(38) +
        '  kind          scope                     transport       safety       summary',
      ...rows,
    ].join('\n'),
    exitCode: 0,
  };
}

function describeOperation(name: string, json: boolean): CommandOutput {
  const operation = operationByName.get(name);
  if (operation === undefined) return usageError(formatUnknownOperation(name));
  if (json) return { stdout: JSON.stringify(operation, null, 2), exitCode: 0 };
  return {
    stdout: formatOperationDescription(operation),
    exitCode: 0,
  };
}

/** Render the `--describe` view of one catalog operation, echoing the summary when it has no description. */
export function formatOperationDescription(operation: CatalogOperationSnapshot): string {
  return [
    `Name: ${operation.name}`,
    `Summary: ${operation.summary}`,
    // Longer-form prose when the operation declares it; otherwise the short
    // summary stands in so `--describe` always shows a Description line.
    `Description: ${operation.description ?? operation.summary}`,
    `Kind: ${operation.kind}`,
    `Scope: ${formatAccess(operation.access)}`,
    `Transport: ${operation.transports.jsonRpcHttp ? 'json-rpc-http' : 'unsupported'}`,
    `Safety: ${operation.destructive ? 'destructive' : 'safe'}`,
    `Input schema: ${JSON.stringify(operation.inputSchema, null, 2)}`,
    `Output schema: ${JSON.stringify(operation.outputSchema, null, 2)}`,
    `Faults: ${JSON.stringify(operation.producibleFaults, null, 2)}`,
  ].join('\n');
}

async function readInput(
  command: ApiCommand,
): Promise<{ ok: true; value: unknown } | { ok: false; output: CommandOutput }> {
  const result = await loadJsonInput(command.input, command.inputFile);
  if (!result.ok) {
    return { ok: false, output: usageError(`api: ${result.error.message}`) };
  }
  return { ok: true, value: result.value === undefined ? {} : result.value };
}

function validateInput(
  operation: ErasedOperation,
  input: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; output: CommandOutput } {
  const operationName = operation.name;
  const parsed = operation.inputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      output: usageError(
        `api: input validation failed for ${operationName}: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; ')}`,
      ),
    };
  }
  return normalizeValidatedInput(operationName, parsed.data);
}

export function normalizeValidatedInput(
  operationName: string,
  parsedData: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; output: CommandOutput } {
  if (parsedData === null || typeof parsedData !== 'object' || Array.isArray(parsedData)) {
    return { ok: false, output: usageError(`api: ${operationName} input must be a JSON object`) };
  }
  return { ok: true, value: Object.fromEntries(Object.entries(parsedData)) };
}

async function callOperation(
  command: ApiCommand,
  operationName: string,
  input: Record<string, unknown>,
): Promise<CommandOutput> {
  let result: Awaited<ReturnType<typeof sendJsonRpcRequest>>;
  try {
    result = await sendJsonRpcRequest(command, operationName, input, 'weft-api');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      stdout: '',
      stderr: `api: connection failed: ${message}`,
      exitCode: 2,
    };
  }

  if (!result.ok) {
    if (command.json) {
      return {
        stdout: JSON.stringify({ ok: false, error: result.error }, null, 2),
        exitCode: 1,
      };
    }
    return {
      stdout: '',
      stderr: `api: ${result.error.message}`,
      exitCode: 1,
    };
  }

  return {
    stdout: JSON.stringify(result.result, null, 2),
    exitCode: 0,
  };
}

export function formatAccess(access: CatalogAccessSnapshot): string {
  if (access.kind === 'public' || access.kind === 'authenticated') return access.kind;
  if (access.kind === 'scoped') return access.scopes.join(',');
  if (access.kind === 'optionalAuth') return `optional:${access.scopes.join(',')}`;
  return access.alternatives.map((alternative) => alternative.join('&')).join('|');
}

function formatUnknownOperation(name: string): string {
  const suggestion = findNearestCandidate(
    name,
    snapshot.operations.map((operation) => operation.name),
    6,
  );
  const suffix = suggestion === undefined ? '' : `. Did you mean ${suggestion}?`;
  return `api: unknown operation ${name}${suffix}. Run weft api --list`;
}

function usageError(message: string): CommandOutput {
  return { stdout: '', stderr: message, exitCode: 3 };
}

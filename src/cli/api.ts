import { createLiveOperationRegistry } from '../server/rest-bindings.ts';
import snapshotData from './generated/operation-catalog.snapshot.json';
import { sendJsonRpcRequest } from './json-rpc-client.ts';
import type { CatalogOperationSnapshot, CatalogSnapshot } from './operation-catalog-snapshot.ts';
import type { CliCommand, CommandOutput } from './types.ts';

type ApiCommand = Extract<CliCommand, { command: 'api' }>;

const snapshot = snapshotData as CatalogSnapshot;
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

  const validation = validateInput(operation.name, inputResult.value);
  if (!validation.ok) return validation.output;

  return callOperation(command, operation.name, validation.value);
}

function resolveInvokableOperation(
  command: ApiCommand,
): { ok: true; operation: CatalogOperationSnapshot } | { ok: false; output: CommandOutput } {
  if (command.operationName === undefined) {
    return {
      ok: false,
      output: usageError('api: expected --list, --describe <operation-name>, or an operation name'),
    };
  }

  const operation = operationByName.get(command.operationName);
  if (operation === undefined)
    return { ok: false, output: usageError(formatUnknownOperation(command.operationName)) };
  return assertInvokableOperation(operation, command.yes);
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
    scope: formatAccess(operation),
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

function formatOperationDescription(operation: CatalogOperationSnapshot): string {
  return [
    `Name: ${operation.name}`,
    `Summary: ${operation.summary}`,
    // Longer-form prose when the operation declares it; otherwise the short
    // summary stands in so `--describe` always shows a Description line.
    `Description: ${operation.description ?? operation.summary}`,
    `Kind: ${operation.kind}`,
    `Scope: ${formatAccess(operation)}`,
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
  if (command.input !== undefined) return parseInput(command.input);
  if (command.inputFile !== undefined) {
    if (command.inputFile === '-') return parseInput(await Bun.stdin.text());
    const file = Bun.file(command.inputFile);
    if (!(await file.exists())) {
      return { ok: false, output: usageError(`api: input file not found: ${command.inputFile}`) };
    }
    return parseInput(await file.text());
  }
  return { ok: true, value: {} };
}

function parseInput(
  source: string,
): { ok: true; value: unknown } | { ok: false; output: CommandOutput } {
  try {
    return { ok: true, value: JSON.parse(source) as unknown };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, output: usageError(`api: invalid JSON input: ${message}`) };
  }
}

function validateInput(
  operationName: string,
  input: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; output: CommandOutput } {
  const operation = createLiveOperationRegistry().get(operationName);
  if (operation === undefined)
    return { ok: false, output: usageError(formatUnknownOperation(operationName)) };
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
  if (parsed.data === null || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) {
    return { ok: false, output: usageError(`api: ${operationName} input must be a JSON object`) };
  }
  return { ok: true, value: parsed.data as Record<string, unknown> };
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

function formatAccess(operation: CatalogOperationSnapshot): string {
  const access = operation.access;
  if (access.kind === 'public' || access.kind === 'authenticated') return access.kind;
  if (access.kind === 'scoped') return access.scopes.join(',');
  if (access.kind === 'optionalAuth') return `optional:${access.scopes.join(',')}`;
  return access.alternatives.map((alternative) => alternative.join('&')).join('|');
}

function formatUnknownOperation(name: string): string {
  const suggestion = findNearest(
    name,
    snapshot.operations.map((operation) => operation.name),
  );
  const suffix = suggestion === undefined ? '' : `. Did you mean ${suggestion}?`;
  return `api: unknown operation ${name}${suffix}. Run weft api --list`;
}

function findNearest(value: string, candidates: readonly string[]): string | undefined {
  let nearest: string | undefined;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = editDistance(value, candidate);
    if (distance < nearestDistance) {
      nearest = candidate;
      nearestDistance = distance;
    }
  }
  return nearestDistance <= 6 ? nearest : undefined;
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_value, index) => index);
  const current = Array.from({ length: right.length + 1 }, () => 0);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        previous[rightIndex]! + 1,
        current[rightIndex - 1]! + 1,
        previous[rightIndex - 1]! + substitutionCost,
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length]!;
}

function usageError(message: string): CommandOutput {
  return { stdout: '', stderr: message, exitCode: 3 };
}

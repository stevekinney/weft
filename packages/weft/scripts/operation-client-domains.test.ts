import { expect, test } from 'bun:test';
import type { CatalogOperationSnapshot } from '../src/server/operation-catalog-snapshot.ts';
import { createOperationClientSources } from './generate-operation-client.ts';
import { operationDomains } from './operation-client-domains.ts';

function operation(name: string, tags: string[]): CatalogOperationSnapshot {
  return {
    name,
    tags,
    kind: 'unary',
    summary: name,
    destructive: false,
    access: { kind: 'public' },
    transports: { http: true, jsonRpcHttp: true, jsonRpcStdio: true, jsonRpcWebSocket: true },
    producibleFaults: [],
    inputSchema: { type: 'object' },
    outputSchema: { type: 'string' },
  };
}

test('every operation belongs to exactly one semantic domain', () => {
  const operations = [
    operation('weft.workflows.bulk.cancel', ['Workflows']),
    operation('weft.workflows.list', ['Workflows']),
    operation('weft.tasks.get', ['Observability']),
    operation('weft.tasks.diagnostics', ['Observability']),
    operation('weft.workers.diagnostics', ['Observability']),
    operation('weft.other.test', []),
  ];
  const domains = operationDomains(operations);
  expect(domains.map(({ name }) => name)).toEqual([
    'Bulk Workflows',
    'Other',
    'Task Detail',
    'Task Diagnostics',
    'Worker Diagnostics',
    'Workflows',
  ]);
  expect(
    domains
      .flatMap((domain) => domain.operations)
      .map(({ name }) => name)
      .toSorted(),
  ).toEqual(operations.map(({ name }) => name).toSorted());
});

test('domain file collisions fail instead of overwriting an operation contract', () => {
  expect(() =>
    operationDomains([
      operation('weft.first.test', ['Task Diagnostics']),
      operation('weft.second.test', ['Task-Diagnostics']),
    ]),
  ).toThrow('Operation domains collide at task-diagnostics-operations.generated.ts');
  expect(() => operationDomains([operation('weft.invalid.test', ['---'])])).toThrow(
    'Operation domain requires an alphanumeric name',
  );
});

test('domain names cannot generate invalid or duplicate TypeScript identifiers', () => {
  expect(() => operationDomains([operation('weft.invalid.test', ['123 Tasks'])])).toThrow(
    'Operation domain must start with a letter',
  );
  expect(() =>
    operationDomains([
      operation('weft.first.test', ['Task Detail']),
      operation('weft.second.test', ['TaskDetail']),
    ]),
  ).toThrow('Operation domain types collide at TaskDetailOperationTypes');
});

test('an empty catalog emits a usable empty client without phantom domain imports', async () => {
  const sources = await createOperationClientSources({
    generatedBy: 'weft catalog snapshot',
    version: 1,
    operations: [],
  });
  expect([...sources.keys()]).toEqual(['operation-client.generated.ts']);
  const client = sources.get('operation-client.generated.ts');
  expect(client).toContain('export type ClientOperationTypes = {};');
  expect(client).not.toContain('-operations.generated.ts');
});

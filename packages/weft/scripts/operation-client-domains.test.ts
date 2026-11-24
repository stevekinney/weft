import { expect, test } from 'bun:test';

import type { CatalogOperationSnapshot } from "../src/embedded/backchannel/src/index.ts";
import { createCatalogSnapshot } from '../src/server/weft-catalog-snapshot.ts';
import { weftOperationDomainName } from './operation-client-domains.ts';
import { generatedSourcesText } from './operation-client-test-support.ts';

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

test('Weft splits bulk execution, task detail and the diagnostics out of their tags', () => {
  expect(weftOperationDomainName(operation('weft.workflows.bulk.cancel', ['Workflows']))).toBe(
    'Bulk Workflows',
  );
  expect(weftOperationDomainName(operation('weft.workflows.list', ['Workflows']))).toBe(
    'Workflows',
  );
  expect(weftOperationDomainName(operation('weft.tasks.get', ['Observability']))).toBe(
    'Task Detail',
  );
  expect(weftOperationDomainName(operation('weft.tasks.diagnostics', ['Observability']))).toBe(
    'Task Diagnostics',
  );
  expect(weftOperationDomainName(operation('weft.workers.diagnostics', ['Observability']))).toBe(
    'Worker Diagnostics',
  );
  expect(weftOperationDomainName(operation('weft.other.test', []))).toBe('Other');
});

test('the generated client keeps those domains as files of their own', async () => {
  const source = await generatedSourcesText(createCatalogSnapshot());
  expect(source).toContain('BulkWorkflowsOperationTypes');
  expect(source).toContain('TaskDetailOperationTypes');
  expect(source).toContain('WorkerDiagnosticsOperationTypes');
});

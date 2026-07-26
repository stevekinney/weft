import { describe, expect, it } from 'bun:test';

import { shapeOperationFaultAsJson, type OperationFault } from '../operation-fault.ts';
import { invalidParamsFault, shapeRestFault } from './operation-helpers.ts';

const operationsDirectory = new URL('.', import.meta.url);

async function expectJsonErrorResponse(
  response: Response,
  expectedStatus: number,
  expectedMessage: string,
  expectedData?: Readonly<Record<string, unknown>>,
): Promise<void> {
  expect(response.status).toBe(expectedStatus);
  expect(response.headers.get('Content-Type')).toBe('application/json');
  expect(await response.json()).toEqual(
    expectedData === undefined
      ? { error: expectedMessage }
      : { error: expectedMessage, data: expectedData },
  );
}

async function operationSourceFiles(): Promise<string[]> {
  const glob = new Bun.Glob('*.ts');
  const files: string[] = [];

  for await (const file of glob.scan({
    cwd: operationsDirectory.pathname,
    onlyFiles: true,
  })) {
    if (!file.endsWith('.test.ts')) {
      files.push(file);
    }
  }

  return files.toSorted();
}

describe('REST fault shaper regressions', () => {
  it('masks canonical EngineFailure responses while preserving mapped client faults', async () => {
    const engineFailureFault: OperationFault = {
      code: 'EngineFailure',
      message: 'database password leaked by implementation detail',
      data: {},
    };
    const invalidParamsFaultValue = invalidParamsFault('Filter must include a status');
    const notFoundFault: OperationFault = {
      code: 'NotFound',
      message: 'Workflow not found',
      data: { resource: 'workflow', identifier: 'workflow-1' },
    };

    await expectJsonErrorResponse(shapeRestFault(engineFailureFault), 500, 'Internal server error');
    await expectJsonErrorResponse(
      shapeRestFault(invalidParamsFaultValue),
      400,
      invalidParamsFaultValue.message,
    );
    await expectJsonErrorResponse(shapeRestFault(notFoundFault), 404, notFoundFault.message, {
      resource: 'workflow',
      identifier: 'workflow-1',
    });
  });

  it('emits a top-level weftCode sibling when the fault carries one (#465)', async () => {
    const notFoundWithCode: OperationFault = {
      code: 'NotFound',
      message: 'Workflow "wf-1" not found',
      data: { resource: 'workflow', identifier: 'wf-1', weftCode: 'WorkflowNotFoundError' },
    };
    const invalidParamsWithCode = invalidParamsFault(
      'No workflow registered with name "x"',
      'WorkflowNotRegisteredError',
    );

    const notFoundResponse = shapeRestFault(notFoundWithCode);
    expect(notFoundResponse.status).toBe(404);
    expect(await notFoundResponse.json()).toEqual({
      error: 'Workflow "wf-1" not found',
      weftCode: 'WorkflowNotFoundError',
      data: { resource: 'workflow', identifier: 'wf-1' },
    });

    const invalidParamsResponse = shapeRestFault(invalidParamsWithCode);
    expect(invalidParamsResponse.status).toBe(400);
    expect(await invalidParamsResponse.json()).toEqual({
      error: 'No workflow registered with name "x"',
      weftCode: 'WorkflowNotRegisteredError',
    });
  });

  it('does not leak a weftCode for the masked EngineFailure path (#465)', async () => {
    // EngineFailure carries no weftCode and must stay byte-identical to the
    // masked body — the sibling must never expose internal detail.
    const engineFailureFault: OperationFault = {
      code: 'EngineFailure',
      message: 'internal detail',
      data: {},
    };
    const response = shapeRestFault(engineFailureFault, {
      message: 'override must not leak',
      status: 418,
    });
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('{"error":"Internal server error"}');
  });

  it('projects only the audited per-code data allowlist over REST (#720)', async () => {
    const validationIssueWithInternalDetail = {
      path: ['operation'],
      message: 'Invalid option',
      code: 'invalid_value',
      internalDetail: 'must not cross the REST boundary',
    };
    const faults: OperationFault[] = [
      { code: 'Unauthorized', message: 'Unauthorized', data: { reason: 'credential detail' } },
      { code: 'Forbidden', message: 'Forbidden', data: { reason: 'scope detail' } },
      {
        code: 'NotFound',
        message: 'Workflow not found',
        data: {
          resource: 'workflow',
          identifier: 'workflow-1',
          weftCode: 'WorkflowNotFoundError',
        },
      },
      {
        code: 'Conflict',
        message: 'Recovery conflict',
        data: {
          reason: 'internal duplicate of the public message',
          missingTypes: ['payments'],
          missingWorkflowCount: 2,
          samplesTruncated: true,
        },
      },
      { code: 'Unprocessable', message: 'Unprocessable', data: { reason: 'engine detail' } },
      { code: 'PayloadTooLarge', message: 'Too large', data: { maxBytes: 1024 } },
      { code: 'Timeout', message: 'Timed out', data: { operationName: 'weft.workflows.update' } },
      { code: 'NotImplemented', message: 'Not implemented', data: {} },
      {
        code: 'UnsupportedTransport',
        message: 'Unsupported transport',
        data: { transport: 'http-rest', supported: ['jsonRpcHttp'] },
      },
      {
        code: 'SubscriptionOverflow',
        message: 'Subscription overflow',
        data: { subscriptionId: 'private-subscription-id', droppedCount: 3 },
      },
      {
        code: 'InvalidParams',
        message: 'Invalid parameters',
        data: { issues: [validationIssueWithInternalDetail] },
      },
      { code: 'MethodNotFound', message: 'Unknown method', data: { method: 'weft.unknown' } },
    ];

    const bodies = await Promise.all(faults.map(async (fault) => shapeRestFault(fault).json()));
    expect(bodies).toEqual([
      { error: 'Unauthorized' },
      { error: 'Forbidden' },
      {
        error: 'Workflow not found',
        weftCode: 'WorkflowNotFoundError',
        data: { resource: 'workflow', identifier: 'workflow-1' },
      },
      {
        error: 'Recovery conflict',
        data: {
          missingTypes: ['payments'],
          missingWorkflowCount: 2,
          samplesTruncated: true,
        },
      },
      { error: 'Unprocessable' },
      { error: 'Too large', data: { maxBytes: 1024 } },
      { error: 'Timed out', data: { operationName: 'weft.workflows.update' } },
      { error: 'Not implemented' },
      {
        error: 'Unsupported transport',
        data: { transport: 'http-rest', supported: ['jsonRpcHttp'] },
      },
      { error: 'Subscription overflow', data: { droppedCount: 3 } },
      {
        error: 'Invalid parameters',
        data: {
          issues: [{ path: ['operation'], message: 'Invalid option', code: 'invalid_value' }],
        },
      },
      { error: 'Unknown method', data: { method: 'weft.unknown' } },
    ]);
  });

  it('keeps shapeOperationFaultAsJson on the canonical REST projection (#720)', async () => {
    const fault: OperationFault = {
      code: 'NotFound',
      message: 'Workflow not found',
      data: { resource: 'workflow', identifier: 'workflow-1' },
    };

    const [canonical, operationSpecific] = await Promise.all([
      shapeRestFault(fault).text(),
      shapeOperationFaultAsJson(fault).text(),
    ]);
    expect(operationSpecific).toBe(canonical);
  });

  it('omits weftCode entirely for invalidParamsFault without a code (#465)', () => {
    expect(invalidParamsFault('Missing filter')).toEqual({
      code: 'InvalidParams',
      message: 'Missing filter',
      data: { issues: [] },
    });
    expect(invalidParamsFault('Bad type', 'WorkflowNotRegisteredError')).toEqual({
      code: 'InvalidParams',
      message: 'Bad type',
      data: { issues: [], weftCode: 'WorkflowNotRegisteredError' },
    });
  });

  it('constructs invalid-params faults in the shared operation helpers', () => {
    expect(invalidParamsFault('Missing filter')).toEqual({
      code: 'InvalidParams',
      message: 'Missing filter',
      data: { issues: [] },
    });
  });

  it('routes canonical JSON error envelopes through shared helpers', async () => {
    const allowedCustomEnvelopeFiles = new Set([
      // Recovery conflicts include machine-readable fields in addition to
      // `{ error }`, so that response is intentionally not a canonical envelope.
      'recover-all.ts',
    ]);
    const violatingFiles: string[] = [];

    for (const file of await operationSourceFiles()) {
      if (file === 'operation-helpers.ts' || allowedCustomEnvelopeFiles.has(file)) {
        continue;
      }

      const source = await Bun.file(new URL(file, operationsDirectory)).text();
      if (/new Response\(\s*JSON\.stringify\(\{\s*error:/u.test(source)) {
        violatingFiles.push(file);
      }
    }

    expect(violatingFiles).toEqual([]);
  });

  it('rejects default-equivalent REST shapers in operation bindings', async () => {
    const forbiddenPatterns = [
      /function\s+shape[A-Za-z]+Fault\(fault:\s*OperationFault\):\s*Response\s*\{\s*return\s+shapeRestFault\(fault\);\s*\}/su,
      /shapeFault:\s*shapeRestFault\b/u,
      /function\s+shape[A-Za-z]+Success\([^)]*\):\s*Response\s*\{\s*return\s+new\s+Response\(JSON\.stringify\([^)]*\),\s*\{\s*status:\s*200,\s*headers:\s*\{\s*['"]Content-Type['"]:\s*['"]application\/json['"]\s*\},\s*\}\);\s*\}/su,
      /shapeSuccess:\s*\([^)]*\)\s*=>\s*new\s+Response\(JSON\.stringify\([^)]*\),\s*\{\s*status:\s*200,\s*headers:\s*\{\s*['"]Content-Type['"]:\s*['"]application\/json['"]\s*\},\s*\}\)/su,
      new RegExp(['shapeBulk', 'JsonSuccess'].join(''), 'u'),
    ];
    const violations: string[] = [];

    for (const file of await operationSourceFiles()) {
      const source = await Bun.file(new URL(file, operationsDirectory)).text();
      for (const pattern of forbiddenPatterns) {
        if (pattern.test(source)) violations.push(`${file}: ${pattern.source}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps invalid-params fault construction in operation helpers', async () => {
    const source = await Bun.file(new URL('bulk-filter-helpers.ts', operationsDirectory)).text();

    expect(source).toMatch(
      /import\s+\{[^}]*\binvalidParamsFault\b[^}]*\}\s+from\s+['"]\.\/operation-helpers\.ts['"]/u,
    );
    expect(source).not.toContain('function invalidParamsFault');
    expect(source).not.toContain('export function invalidParamsFault');
  });
});

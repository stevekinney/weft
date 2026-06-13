import { describe, expect, it } from 'bun:test';

import type { OperationFault } from '../operation-fault.ts';
import { invalidParamsFault, shapeRestFault } from './operation-helpers.ts';

const operationsDirectory = new URL('.', import.meta.url);

async function expectJsonErrorResponse(
  response: Response,
  expectedStatus: number,
  expectedMessage: string,
): Promise<void> {
  expect(response.status).toBe(expectedStatus);
  expect(response.headers.get('Content-Type')).toBe('application/json');
  expect(await response.json()).toEqual({ error: expectedMessage });
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
    await expectJsonErrorResponse(shapeRestFault(notFoundFault), 404, notFoundFault.message);
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
    expect(await shapeRestFault(engineFailureFault).json()).toEqual({
      error: 'Internal server error',
    });
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

  it('keeps invalid-params fault construction in operation helpers', async () => {
    const source = await Bun.file(new URL('bulk-filter-helpers.ts', operationsDirectory)).text();

    expect(source).toMatch(
      /import\s+\{\s*invalidParamsFault\s*\}\s+from\s+['"]\.\/operation-helpers\.ts['"]/u,
    );
    expect(source).not.toContain('function invalidParamsFault');
    expect(source).not.toContain('export function invalidParamsFault');
  });
});

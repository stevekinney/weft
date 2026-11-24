import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../embedded/storage/src/index.ts";
import { throwingRejectionOf } from "../../test-support/embedded/testing/src/helpers/promise-outcome.ts";

import { Engine } from '../core/engine/index.ts';
import { WorkflowDocumentSchemaError } from './document-errors.ts';
import {
  WorkflowDocumentValidationError,
  canonicalWorkflowDocumentJson,
  validateWorkflowDocument,
  workflowDocumentVersion,
  type DocumentSchemaChecker,
  type DocumentWorkflowHost,
} from './document.ts';
import { registerWorkflowDocuments } from './register.ts';

const checks: { point: string; schema: unknown; value: unknown }[] = [];

/** Accepts a value unless it is the string `bad`, which it refuses with one issue. */
const checkSchema: DocumentSchemaChecker = (point, schema, value) => {
  checks.push({ point, schema, value });
  return value === 'bad' ? [{ path: 'value', message: 'is bad' }] : [];
};

const activities: DocumentWorkflowHost['activities'] = {
  echo: ({ input }) => input,
};

const checkingHost: DocumentWorkflowHost = {
  activities,
  triggerKinds: { manual: () => undefined },
  checkSchema,
};

const plainHost: DocumentWorkflowHost = {
  activities,
  triggerKinds: { manual: () => undefined },
};

function document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'schema-document',
    trigger: { kind: 'manual' },
    steps: [{ kind: 'activity', handler: 'echo', input: 'ok' }],
    ...overrides,
  };
}

describe('a document with an input or output schema', () => {
  it('keeps the version it had without schemas, and takes a different one with them', async () => {
    const without = validateWorkflowDocument(document(), checkingHost);
    const withInput = validateWorkflowDocument(
      document({ inputSchema: { type: 'object' } }),
      checkingHost,
    );
    const withOutput = validateWorkflowDocument(
      document({ outputSchema: { type: 'string' } }),
      checkingHost,
    );

    expect(canonicalWorkflowDocumentJson(without)).not.toContain('Schema');
    expect(Object.hasOwn(without, 'inputSchema')).toBe(false);
    const versions = await Promise.all(
      [without, withInput, withOutput].map((candidate) => workflowDocumentVersion(candidate)),
    );
    expect(new Set(versions).size).toBe(3);
  });

  it('is refused by a host that cannot check schemas, naming each schema', () => {
    try {
      validateWorkflowDocument(
        document({ inputSchema: { type: 'object' }, outputSchema: { type: 'string' } }),
        plainHost,
      );
      throw new Error('expected the document to be refused');
    } catch (error) {
      if (!(error instanceof WorkflowDocumentValidationError)) throw error;
      expect(error.issues.map((issue) => issue.path)).toEqual(['inputSchema', 'outputSchema']);
    }
  });

  it('is refused when a schema is not a JSON object', () => {
    for (const bad of [null, 'string', ['array'], 3]) {
      expect(() => validateWorkflowDocument(document({ inputSchema: bad }), checkingHost)).toThrow(
        WorkflowDocumentValidationError,
      );
    }
  });

  it('checks the start input before the first step and the result after the last', async () => {
    checks.length = 0;
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    await registerWorkflowDocuments(engine, checkingHost, {
      active: [document({ inputSchema: { type: 'object' }, outputSchema: { type: 'string' } })],
    });

    const run = await engine.start('schema-document', { from: 'caller' }, { id: 'valid-run' });

    expect(await run.result()).toBe('ok');
    expect(checks).toEqual([
      { point: 'input', schema: { type: 'object' }, value: { from: 'caller' } },
      { point: 'output', schema: { type: 'string' }, value: 'ok' },
    ]);
  });

  it('fails the instance with input-invalid and its issues, before any step runs', async () => {
    let stepRan = false;
    const host: DocumentWorkflowHost = {
      ...checkingHost,
      activities: {
        echo: () => {
          stepRan = true;
          return 'ran';
        },
      },
    };
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    await registerWorkflowDocuments(engine, host, {
      active: [document({ inputSchema: { type: 'object' } })],
    });

    const run = await engine.start('schema-document', 'bad', { id: 'bad-input-run' });

    expect(await throwingRejectionOf(run.result())).toThrow('input-invalid: value: is bad');
    expect(stepRan).toBe(false);
    const failed = await engine.get('bad-input-run');
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toBe('input-invalid: value: is bad');
  });

  it('fails the instance with output-invalid and its issues when the result breaks the schema', async () => {
    const host: DocumentWorkflowHost = {
      ...checkingHost,
      activities: { echo: () => 'bad' },
    };
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    await registerWorkflowDocuments(engine, host, {
      active: [document({ outputSchema: { type: 'string' } })],
    });

    const run = await engine.start('schema-document', null, { id: 'bad-output-run' });

    expect(await throwingRejectionOf(run.result())).toThrow('output-invalid: value: is bad');
    const failed = await engine.get('bad-output-run');
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toBe('output-invalid: value: is bad');
  });

  it('carries the code and the issues on WorkflowDocumentSchemaError', () => {
    const error = new WorkflowDocumentSchemaError('output-invalid', [
      { path: 'total', message: 'is required' },
      { path: '', message: 'is not valid' },
    ]);

    expect(error.code).toBe('output-invalid');
    expect(error.message).toBe('output-invalid: total: is required; is not valid');
    expect(error.issues).toHaveLength(2);
  });
});

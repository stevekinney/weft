import { describe, expect, it } from 'bun:test';

import { createOperationRegistry } from "../../embedded/backchannel/src/internals.ts";
import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { waitForCondition } from "../../../test-support/embedded/testing/src/fake-timers.ts";
import { decode } from '../../core/codec.ts';
import { Engine } from '../../core/engine.ts';
import { type WorkflowContext, workflow } from '../../core/types.ts';
import { KEYS } from '../../storage/keys.ts';
import { handleRequestAsLocalUser as handleRequest } from '../local-user-request.test-support.ts';
import {
  setWorkflowAttributesOperation,
  setWorkflowAttributesRestBinding,
} from './set-workflow-attributes.ts';

const echoWorkflow = workflow({ name: 'echo' }).execute(async function* (
  _ctx: WorkflowContext,
  input: unknown,
) {
  return input;
});

function createEngine(): { engine: Engine; storage: MemoryStorage } {
  const storage = new MemoryStorage();
  const engine = new Engine({ storage });
  engine.register(echoWorkflow);
  return { engine, storage };
}

const registry = createOperationRegistry([setWorkflowAttributesOperation]);
const bindings = [setWorkflowAttributesRestBinding];

describe('weft.workflows.attributes.set', () => {
  it('sets attributes on a workflow and returns the ok response', async () => {
    const { engine, storage } = createEngine();

    const response = await handleRequest(
      request('PATCH', '/v1/workflows/workflow-1/attributes', {
        attributes: { priority: 'high', score: 5 },
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    const stored = await storage.get(KEYS.attribute('workflow-1'));
    expect(stored).not.toBeNull();
    expect(decode(stored!)).toEqual({ priority: 'high', score: 5 });

    engine[Symbol.dispose]();
  });

  it('defaults to an empty attributes object when the field is missing', async () => {
    const { engine } = createEngine();

    const response = await handleRequest(
      request('PATCH', '/v1/workflows/workflow-2/attributes', {}),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    engine[Symbol.dispose]();
  });

  it('returns 400 when the request body is invalid JSON', async () => {
    const { engine } = createEngine();

    const response = await handleRequest(
      new Request('http://localhost/v1/workflows/workflow-3/attributes', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      }),
      engine,
      {
        operationRegistry: registry,
        restBindings: bindings,
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid JSON body' });

    engine[Symbol.dispose]();
  });

  describe('date-time attributes', () => {
    const scheduled = workflow({ name: 'scheduled-job' })
      .searchAttributes({
        runAfter: { type: 'string', format: 'date-time' },
        label: { type: 'string' },
      })
      .execute(async function* (ctx: WorkflowContext) {
        yield* ctx.waitForSignal('finish');
        return 'done';
      });

    async function startScheduled(): Promise<{
      engine: Engine;
      storage: MemoryStorage;
      id: string;
    }> {
      const storage = new MemoryStorage();
      const engine = new Engine({ storage });
      engine.register(scheduled);
      const handle = await engine.start('scheduled-job', undefined, {
        searchAttributes: { runAfter: new Date('2026-01-01T00:00:00.000Z'), label: 'first' },
      });
      handle.result().catch(() => {});
      await waitForCondition(async () => (await engine.getAttributes(handle.id)) !== null);
      return { engine, storage, id: handle.id };
    }

    it('converts an ISO string for an attribute the schema declares date-time', async () => {
      const { engine, storage, id } = await startScheduled();
      try {
        const response = await handleRequest(
          request('PATCH', `/v1/workflows/${id}/attributes`, {
            attributes: { runAfter: '2026-06-15T12:30:00.000Z' },
          }),
          engine,
          { operationRegistry: registry, restBindings: bindings },
        );

        expect(response.status).toBe(200);
        const stored = decode((await storage.get(KEYS.attribute(id)))!) as Record<string, unknown>;
        expect(stored['runAfter']).toBeInstanceOf(Date);
        expect((stored['runAfter'] as Date).toISOString()).toBe('2026-06-15T12:30:00.000Z');
        // The other attribute is merged, not replaced, and a plain string stays a string.
        expect(stored['label']).toBe('first');
      } finally {
        engine[Symbol.dispose]();
      }
    });

    it('leaves a string for a plain string attribute as a string', async () => {
      const { engine, storage, id } = await startScheduled();
      try {
        const response = await handleRequest(
          request('PATCH', `/v1/workflows/${id}/attributes`, {
            attributes: { label: '2026-06-15T12:30:00.000Z' },
          }),
          engine,
          { operationRegistry: registry, restBindings: bindings },
        );

        expect(response.status).toBe(200);
        const stored = decode((await storage.get(KEYS.attribute(id)))!) as Record<string, unknown>;
        expect(stored['label']).toBe('2026-06-15T12:30:00.000Z');
      } finally {
        engine[Symbol.dispose]();
      }
    });

    it('leaves a value that is not an object for the engine to refuse, as it did before', async () => {
      const { engine, storage, id } = await startScheduled();
      try {
        const response = await handleRequest(
          request('PATCH', `/v1/workflows/${id}/attributes`, {
            attributes: ['2026-06-15T12:30:00.000Z'],
          }),
          engine,
          { operationRegistry: registry, restBindings: bindings },
        );

        // The engine rejects the "0" key the array spreads into, which is masked as a server error.
        expect(response.status).toBe(500);
        const stored = decode((await storage.get(KEYS.attribute(id)))!) as Record<string, unknown>;
        expect(Object.keys(stored).toSorted()).toEqual(['label', 'runAfter']);
      } finally {
        engine[Symbol.dispose]();
      }
    });

    it('refuses a string that is not a date-time as invalid parameters, leaving the stored value', async () => {
      const { engine, storage, id } = await startScheduled();
      try {
        const response = await handleRequest(
          request('PATCH', `/v1/workflows/${id}/attributes`, {
            attributes: { runAfter: 'next tuesday' },
          }),
          engine,
          { operationRegistry: registry, restBindings: bindings },
        );

        expect(response.status).toBe(400);
        expect(((await response.json()) as { error: string }).error).toContain(
          'must be a valid date-time string',
        );
        const stored = decode((await storage.get(KEYS.attribute(id)))!) as Record<string, unknown>;
        expect((stored['runAfter'] as Date).toISOString()).toBe('2026-01-01T00:00:00.000Z');
      } finally {
        engine[Symbol.dispose]();
      }
    });
  });

  it('returns the sanitized 500 body when the engine throws', async () => {
    const { engine } = createEngine();
    const originalSetAttributes = engine.setAttributes.bind(engine);
    engine.setAttributes = async () => {
      throw new Error('secret internal detail');
    };

    try {
      const response = await handleRequest(
        request('PATCH', '/v1/workflows/workflow-4/attributes', {
          attributes: { priority: 'low' },
        }),
        engine,
        {
          operationRegistry: registry,
          restBindings: bindings,
        },
      );

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Internal server error', retryable: false });
    } finally {
      engine.setAttributes = originalSetAttributes;
      engine[Symbol.dispose]();
    }
  });
});

function request(method: string, path: string, body?: unknown): Request {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  return new Request(`http://localhost${path}`, init);
}

/**
 * `weft.system.registry` operation + REST binding — unit tests.
 *
 * Covers:
 * - Snapshot of the response body for a fixture engine with workflows and
 *   activities, with both schema-present and schema-absent cases.
 * - registryVersion: 2 in the response, `generatedAt`, `activeRevisions`.
 * - Authorization: 401 unauthenticated, 403 missing scope, 200 with system:read.
 * - Masked 500 (`{ error: 'Internal server error' }`) when an unsupported
 *   validator throws, or when a registered contract exceeds a WFT-5 limit;
 *   the offending detail reaches server-side logs only, never the wire.
 * - Workflows registered out of alphabetical order produce sorted output.
 * - Remote-only activities are excluded by construction (engine never sees them).
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { z } from 'zod';

import { MAX_CONTRACT_IDENTIFIER_BYTES } from '../../core/contract/index.ts';
import { Engine } from '../../core/engine.ts';
import { activity, query, signal, update, workflow } from '../../core/types.ts';
import { MemoryStorage } from '../../storage/memory.ts';
import { handleRequest } from '../handler.ts';
import { createOperationRegistry, executeOperation } from '../operation-catalog.ts';
import { principalFromApiKey, principalFromJwtClaims } from '../principal.ts';
import { createLiveOperationRegistry } from '../rest-bindings.ts';
import { getRegistryOperation, getRegistryRestBinding } from './get-registry.ts';

const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/;

interface RegistryBody {
  registryVersion: number;
  generatedAt: string;
  workflows: Array<{ name: string; revision: string; contract: Record<string, unknown> }>;
  activeRevisions: Record<string, string>;
  activities: Record<string, unknown>;
}

function createEngine(): Engine {
  return new Engine({ storage: new MemoryStorage() });
}

function authContextWithSystemRead() {
  return {
    authContext: {
      method: 'api-key' as const,
      principal: principalFromApiKey({ subject: 'test', scopes: ['system:read'] }),
    },
  };
}

describe('GET /v1/registry — successful responses', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('returns the snapshot for a populated engine', async () => {
    engine = createEngine();
    engine.register(
      workflow({
        name: 'welcome',
        inputSchema: z.object({ name: z.string() }),
        outputSchema: z.object({ greeting: z.string() }),
        description: 'Greets a person.',
        tags: ['greeting'],
      })
        .signals({ wave: signal('wave', { inputSchema: z.object({ times: z.number() }) }) })
        .updates({
          rename: update('rename', {
            inputSchema: z.object({ name: z.string() }),
            outputSchema: z.object({ accepted: z.boolean() }),
          }),
        })
        .queries({
          status: query('status', { outputSchema: z.object({ state: z.string() }) }),
        })
        .execute(async function* () {
          return { greeting: 'hi' };
        }),
    );
    engine.register(workflow({ name: 'schemaless' }).execute(async function* () {}));
    engine.register(
      activity({
        name: 'sendEmail',
        execute: async (input: { to: string }) => ({ delivered: true, recipient: input.to }),
        queue: 'mail',
        inputSchema: z.object({ to: z.string() }),
        outputSchema: z.object({ delivered: z.boolean(), recipient: z.string() }),
        description: 'Sends an email.',
        retry: {
          maxAttempts: 3,
          initialBackoff: '200ms',
          backoffMultiplier: 2,
          maxBackoff: '5s',
        },
        timeout: '30s',
      }),
    );
    engine.register(activity({ name: 'noop', execute: async () => undefined }));

    const response = await handleRequest(
      new Request('http://localhost/v1/registry', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([getRegistryOperation]),
        restBindings: [getRegistryRestBinding],
        ...authContextWithSystemRead(),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    const body = (await response.json()) as RegistryBody;

    expect(body.registryVersion).toBe(2);
    expect(body.generatedAt).toMatch(ISO_TIMESTAMP_PATTERN);
    expect(body.activeRevisions['welcome']).toMatch(REVISION_PATTERN);
    expect(body.activeRevisions['schemaless']).toMatch(REVISION_PATTERN);
    expect(body.workflows).toHaveLength(2);

    const welcome = body.workflows.find((m) => m.name === 'welcome');
    expect(welcome?.revision).toBe(body.activeRevisions['welcome']);
    expect(welcome?.contract).toEqual({
      name: 'welcome',
      workflowVersion: '0.0.0',
      description: 'Greets a person.',
      tags: ['greeting'],
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: { greeting: { type: 'string' } },
        required: ['greeting'],
        additionalProperties: false,
      },
      signals: {
        wave: {
          inputSchema: {
            type: 'object',
            properties: { times: { type: 'number' } },
            required: ['times'],
            additionalProperties: false,
          },
        },
      },
      updates: {
        rename: {
          inputSchema: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
            additionalProperties: false,
          },
          outputSchema: {
            type: 'object',
            properties: { accepted: { type: 'boolean' } },
            required: ['accepted'],
            additionalProperties: false,
          },
        },
      },
      queries: {
        status: {
          outputSchema: {
            type: 'object',
            properties: { state: { type: 'string' } },
            required: ['state'],
            additionalProperties: false,
          },
        },
      },
    });

    const schemaless = body.workflows.find((m) => m.name === 'schemaless');
    expect(schemaless?.contract).toEqual({ name: 'schemaless', workflowVersion: '0.0.0' });

    expect(body.activities).toEqual({
      noop: { queue: 'default' },
      sendEmail: {
        queue: 'mail',
        inputSchema: {
          type: 'object',
          properties: { to: { type: 'string' } },
          required: ['to'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: {
            delivered: { type: 'boolean' },
            recipient: { type: 'string' },
          },
          required: ['delivered', 'recipient'],
          additionalProperties: false,
        },
        description: 'Sends an email.',
        retry: {
          maxAttempts: 3,
          initialBackoff: '200ms',
          backoffMultiplier: 2,
          maxBackoff: '5s',
        },
        timeout: '30s',
      },
    });
  });

  it('returns an empty snapshot when no workflows or activities are registered', async () => {
    engine = createEngine();

    const response = await handleRequest(
      new Request('http://localhost/v1/registry', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([getRegistryOperation]),
        restBindings: [getRegistryRestBinding],
        ...authContextWithSystemRead(),
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as RegistryBody;
    expect(body.registryVersion).toBe(2);
    expect(body.generatedAt).toMatch(ISO_TIMESTAMP_PATTERN);
    expect(body.workflows).toEqual([]);
    expect(body.activeRevisions).toEqual({});
    expect(body.activities).toEqual({});
  });

  it('produces alphabetically sorted workflow and activity output', async () => {
    engine = createEngine();
    engine.register(workflow({ name: 'charlie' }).execute(async function* () {}));
    engine.register(workflow({ name: 'alpha' }).execute(async function* () {}));
    engine.register(workflow({ name: 'bravo' }).execute(async function* () {}));
    engine.register(activity({ name: 'zulu', execute: async () => undefined }));
    engine.register(activity({ name: 'alpha', execute: async () => undefined }));

    const response = await handleRequest(
      new Request('http://localhost/v1/registry', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([getRegistryOperation]),
        restBindings: [getRegistryRestBinding],
        ...authContextWithSystemRead(),
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as RegistryBody;
    expect(body.workflows.map((m) => m.name)).toEqual(['alpha', 'bravo', 'charlie']);
    expect(Object.keys(body.activities)).toEqual(['alpha', 'zulu']);
  });

  it('preserves __proto__-named workflow and activity keys end-to-end through Zod outputSchema validation', async () => {
    // Regression for the null-prototype map fix: a registered workflow or
    // activity literally named `__proto__` must reach the wire. This is
    // the REST-path counterpart to the builder-level test in
    // registry-snapshot.test.ts — it confirms that the operation pipeline,
    // including the strict Zod outputSchema, does not drop or reshape the
    // entry.
    engine = createEngine();
    engine.register(workflow({ name: '__proto__' }).execute(async function* () {}));
    engine.register(activity({ name: '__proto__', execute: async () => undefined }));

    const response = await handleRequest(
      new Request('http://localhost/v1/registry', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([getRegistryOperation]),
        restBindings: [getRegistryRestBinding],
        ...authContextWithSystemRead(),
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as RegistryBody;
    expect(body.workflows.some((m) => m.name === '__proto__')).toBe(true);
    expect(Object.keys(body.activities)).toContain('__proto__');
    expect(Object.keys(body.activeRevisions)).toContain('__proto__');
    // Sanity: the keys are own properties on the parsed JSON, not prototype
    // entries inherited from `Object.prototype`.
    expect(Object.prototype.hasOwnProperty.call(body.activities, '__proto__')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(body.activeRevisions, '__proto__')).toBe(true);
  });

  it('excludes remote-only activities (engine never registers them)', async () => {
    // The activity registry the snapshot reads from is the engine's local
    // registry. A "remote-only" activity exists in WorkerRegistry, never in
    // ActivityRegistry, so there is no path through which it could appear in
    // the response. This test pins that by construction: register one local
    // activity, assert it is the only one reported.
    engine = createEngine();
    engine.register(activity({ name: 'localOnly', execute: async () => undefined }));

    const response = await handleRequest(
      new Request('http://localhost/v1/registry', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([getRegistryOperation]),
        restBindings: [getRegistryRestBinding],
        ...authContextWithSystemRead(),
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { activities: Record<string, unknown> };
    expect(Object.keys(body.activities)).toEqual(['localOnly']);
    expect(body.activities).not.toHaveProperty('remoteOnly');
  });
});

describe('GET /v1/registry — authorization', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('rejects unauthenticated callers with 401 via executeOperation', async () => {
    engine = createEngine();
    const liveRegistry = createLiveOperationRegistry();

    const result = await executeOperation(
      'weft.system.registry',
      {},
      {
        principal: { method: 'unauthenticated' },
        engine,
        transport: 'jsonRpcStdio',
        registry: liveRegistry,
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.fault.code).toBe('Unauthorized');
  });

  it('rejects callers with insufficient scope as 403 via executeOperation', async () => {
    engine = createEngine();
    const liveRegistry = createLiveOperationRegistry();

    const result = await executeOperation(
      'weft.system.registry',
      {},
      {
        principal: principalFromJwtClaims({ sub: 'user', scope: 'workflows:read' }),
        engine,
        transport: 'jsonRpcStdio',
        registry: liveRegistry,
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejection');
    expect(result.fault.code).toBe('Forbidden');
  });

  it('succeeds with system:read scope via executeOperation', async () => {
    engine = createEngine();
    engine.register(workflow({ name: 'demo' }).execute(async function* () {}));
    const liveRegistry = createLiveOperationRegistry();

    const result = await executeOperation(
      'weft.system.registry',
      {},
      {
        principal: principalFromJwtClaims({ sub: 'user', scope: 'system:read' }),
        engine,
        transport: 'jsonRpcStdio',
        registry: liveRegistry,
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected success');
    const value = result.value as RegistryBody;
    expect(value.registryVersion).toBe(2);
    expect(value.workflows.some((m) => m.name === 'demo')).toBe(true);
  });
});

describe('GET /v1/registry — error shaping', () => {
  let engine: Engine | undefined;

  afterEach(() => {
    engine?.[Symbol.dispose]();
    engine = undefined;
  });

  it('returns 500 with "Internal server error" when a registered schema fails to convert', async () => {
    // Register a workflow with a Standard Schema validator the converter
    // cannot handle. The builder throws RegistrySchemaConversionError; the
    // operation pipeline reduces it to an EngineFailure fault and the REST
    // shaper masks the wire response. The typed error message (which names
    // the offending entity and direction) reaches server-side logs so
    // operators can locate the bad registration; clients see only the
    // generic 500 to avoid leaking internal schema layout.
    engine = createEngine();
    const brokenSchema: any = {
      '~standard': {
        version: 1,
        vendor: 'unknown-test-vendor',
        validate: (value: unknown) => ({ value }),
      },
    };
    engine.register(
      workflow({ name: 'broken', inputSchema: brokenSchema }).execute(async function* () {}),
    );

    const response = await handleRequest(
      new Request('http://localhost/v1/registry', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([getRegistryOperation]),
        restBindings: [getRegistryRestBinding],
        ...authContextWithSystemRead(),
      },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  });

  it('returns 500 with "Internal server error" and logs workflowType/reason when a contract exceeds a WFT-5 limit', async () => {
    // A `version` this long is grammar-valid at registration (nothing in
    // engine registration bounds it) but exceeds `MAX_CONTRACT_IDENTIFIER_BYTES`
    // at manifest-build time — the new v2 failure mode this operation must
    // mask on the wire while still logging enough for an operator to find
    // the bad registration. This is the only test that exercises the
    // `instanceof RegistryManifestLimitError` branch in `invoke`'s catch.
    engine = createEngine();
    engine.register(
      workflow({
        name: 'oversized',
        version: 'a'.repeat(MAX_CONTRACT_IDENTIFIER_BYTES + 1),
      }).execute(async function* () {}),
    );

    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await handleRequest(
        new Request('http://localhost/v1/registry', { method: 'GET' }),
        engine,
        {
          operationRegistry: createOperationRegistry([getRegistryOperation]),
          restBindings: [getRegistryRestBinding],
          ...authContextWithSystemRead(),
        },
      );

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Internal server error' });

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const [message, detail] = errorSpy.mock.calls[0] as [string, { workflowType: string }];
      expect(message).toContain('[weft.system.registry]');
      expect(message).toContain('oversized');
      expect(detail.workflowType).toBe('oversized');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('returns 500 with "Internal server error" for unrelated EngineFailure faults', async () => {
    engine = createEngine();
    const failingOperation = {
      ...getRegistryOperation,
      invoke: async () => {
        throw {
          code: 'EngineFailure' as const,
          message: 'secret internal detail',
          data: {},
        };
      },
    };

    const response = await handleRequest(
      new Request('http://localhost/v1/registry', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([failingOperation]),
        restBindings: [getRegistryRestBinding],
        ...authContextWithSystemRead(),
      },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
  });

  it('shapes a Forbidden fault as 403 via the REST fault shaper', async () => {
    engine = createEngine();
    const forbiddenOperation = {
      ...getRegistryOperation,
      invoke: async () => {
        throw {
          code: 'Forbidden' as const,
          message: 'insufficient scope',
          data: { reason: 'insufficient scope' },
        };
      },
    };

    const response = await handleRequest(
      new Request('http://localhost/v1/registry', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([forbiddenOperation]),
        restBindings: [getRegistryRestBinding],
        ...authContextWithSystemRead(),
      },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'insufficient scope' });
  });

  it('shapes an Unauthorized fault as 401 via the REST fault shaper', async () => {
    engine = createEngine();
    const unauthorizedOperation = {
      ...getRegistryOperation,
      invoke: async () => {
        throw {
          code: 'Unauthorized' as const,
          message: 'no credentials',
          data: { reason: 'no credentials' },
        };
      },
    };

    const response = await handleRequest(
      new Request('http://localhost/v1/registry', { method: 'GET' }),
      engine,
      {
        operationRegistry: createOperationRegistry([unauthorizedOperation]),
        restBindings: [getRegistryRestBinding],
        ...authContextWithSystemRead(),
      },
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'no credentials' });
  });
});

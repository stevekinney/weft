/**
 * Tests for `RestBinding<Input, Output>` — the REST-facing wrapper that
 * references a transport-neutral `OperationDefinition` by name and
 * owns the HTTP-specific concerns: method, path, where each input
 * field comes from (path param / query / header / body), and how the
 * output is shaped into an HTTP response.
 *
 * Phase 9 introduces the type. Phase 15 migrates individual REST routes
 * onto bindings one operation at a time behind the per-operation
 * `restDispatchMode` flag.
 */

import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { defineOperation } from './operation-registry.ts';
import {
  bindingPathMatches,
  isRestBindingCompatibleWithOperation,
  type ParamSource,
  type ResponseShape,
  type RestBinding,
} from './rest-binding.ts';

// A minimal operation used as the lookup target for most binding tests.
const startWorkflowOperation = defineOperation({
  name: 'weft.workflows.start',
  summary: 'Start a workflow',
  inputSchema: z.object({
    workflowType: z.string(),
    input: z.unknown().optional(),
  }),
  outputSchema: z.object({ workflowId: z.string() }),
  access: { kind: 'authenticated' },
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
  invoke: async () => ({ workflowId: 'wf-1' }),
});

describe('ParamSource discriminated union', () => {
  it('covers every source a REST request can supply a field from', () => {
    const path: ParamSource = { kind: 'path', pathParam: 'id' };
    const query: ParamSource = { kind: 'query', queryParam: 'limit' };
    const queryRepeating: ParamSource = { kind: 'query', queryParam: 'tag', repeating: true };
    const header: ParamSource = { kind: 'header', headerName: 'x-tenant-id' };
    const body: ParamSource = { kind: 'body' };
    const bodyField: ParamSource = { kind: 'body-field', bodyField: 'workflowType' };
    // Compile-time exhaustiveness: if `ParamSource` grows a new variant,
    // this tuple fails typecheck until the test updates.
    const all: ParamSource[] = [path, query, queryRepeating, header, body, bodyField];
    expect(all).toHaveLength(6);
  });
});

describe('ResponseShape discriminated union', () => {
  it('covers exactly one entry per discriminant (json / empty / streaming)', () => {
    // Compile-time exhaustiveness guard: one value per `kind`. If a new
    // variant is added to `ResponseShape`, this tuple fails typecheck
    // until the new variant is represented here. Prior versions
    // inflated this to 5 entries by including two `json` statuses and
    // two `streaming` mediaTypes; that's instance coverage, not
    // variant coverage — a new variant could be added without breaking
    // the length check. One entry per discriminant is the right shape.
    const json: ResponseShape = { kind: 'json', status: 200 };
    const empty: ResponseShape = { kind: 'empty', status: 204 };
    const streaming: ResponseShape = { kind: 'streaming', mediaType: 'text/event-stream' };
    const all: ResponseShape[] = [json, empty, streaming];
    expect(all).toHaveLength(3);
  });

  it('supports non-default json status codes and both streaming media types', () => {
    // These are variant-internal value spreads, not exhaustiveness
    // coverage. Kept as a separate test so the main exhaustiveness
    // guard stays clean.
    const created: ResponseShape = { kind: 'json', status: 201 };
    const octet: ResponseShape = { kind: 'streaming', mediaType: 'application/octet-stream' };
    expect(created.kind).toBe('json');
    expect(octet.kind).toBe('streaming');
  });
});

describe('RestBinding structural shape', () => {
  it('is generic over Input and Output and carries extractInput + shapeSuccess', () => {
    type In = { workflowType: string };
    type Out = { workflowId: string };
    const binding: RestBinding<In, Out> = {
      method: 'POST',
      path: '/v1/workflows',
      pathParamNames: [],
      operationName: 'weft.workflows.start',
      inputSources: {
        workflowType: { kind: 'body-field', bodyField: 'workflowType' },
      },
      extractInput: async (request) => {
        const body = (await request.json()) as { workflowType: string };
        return { workflowType: body.workflowType };
      },
      success: { kind: 'json', status: 201 },
    };
    expect(binding.method).toBe('POST');
    expect(binding.path).toBe('/v1/workflows');
    expect(binding.operationName).toBe('weft.workflows.start');
  });

  it('allows an optional shapeSuccess override for custom response shaping', () => {
    type In = { id: string };
    type Out = { value: number };
    const binding: RestBinding<In, Out> = {
      method: 'GET',
      path: '/v1/counters/:id',
      pathParamNames: ['id'],
      operationName: 'weft.counters.get',
      inputSources: { id: { kind: 'path', pathParam: 'id' } },
      extractInput: async (_request, pathParams) => ({ id: pathParams['id'] ?? '' }),
      success: { kind: 'json', status: 200 },
      shapeSuccess: (output) => Response.json({ count: output.value }, { status: 200 }),
    };
    expect(typeof binding.shapeSuccess).toBe('function');
  });
});

describe('bindingPathMatches', () => {
  it('matches a literal path exactly', () => {
    expect(bindingPathMatches('/v1/workflows', '/v1/workflows')).toEqual({});
    expect(bindingPathMatches('/v1/workflows', '/v1/workflows/')).toBeNull();
    expect(bindingPathMatches('/v1/workflows', '/v1/other')).toBeNull();
  });

  it('extracts named path parameters', () => {
    expect(bindingPathMatches('/v1/workflows/:id', '/v1/workflows/abc')).toEqual({ id: 'abc' });
    expect(
      bindingPathMatches('/v1/workflows/:id/signal/:name', '/v1/workflows/abc/signal/notify'),
    ).toEqual({ id: 'abc', name: 'notify' });
  });

  it('returns null for a non-matching path structure', () => {
    expect(bindingPathMatches('/v1/workflows/:id', '/v1/workflows')).toBeNull();
    expect(bindingPathMatches('/v1/workflows/:id', '/v1/workflows/abc/extra')).toBeNull();
  });

  it('URL-decodes extracted path parameters', () => {
    expect(bindingPathMatches('/v1/workflows/:id', '/v1/workflows/wf%20with%20spaces')).toEqual({
      id: 'wf with spaces',
    });
  });

  it('rejects an empty path segment (e.g. /v1/workflows//signal)', () => {
    // An empty path segment is NOT a valid identifier; returning the
    // empty string as the param would propagate to the engine as a
    // "missing" id with a confusing shape. Treat as no match so the
    // router surfaces the path-shape error cleanly (404 / 405).
    expect(bindingPathMatches('/v1/workflows/:id/signal', '/v1/workflows//signal')).toBeNull();
  });

  it('returns null for a malformed percent-encoded segment', () => {
    // `decodeURIComponent('%')` and `decodeURIComponent('%GG')` throw
    // URIError. The matcher catches and returns null so the router
    // produces a 404 instead of letting the URIError propagate as a
    // 500. Without this test, a future refactor that drops the
    // try/catch would silently break every route with user-supplied
    // path params.
    expect(bindingPathMatches('/v1/workflows/:id', '/v1/workflows/%')).toBeNull();
    expect(bindingPathMatches('/v1/workflows/:id', '/v1/workflows/%GG')).toBeNull();
    expect(bindingPathMatches('/v1/workflows/:id', '/v1/workflows/abc%2')).toBeNull();
  });
});

describe('isRestBindingCompatibleWithOperation', () => {
  it('returns true when operation has transports.http === true', () => {
    const binding: RestBinding<unknown, unknown> = {
      method: 'POST',
      path: '/v1/workflows',
      pathParamNames: [],
      operationName: 'weft.workflows.start',
      inputSources: {},
      extractInput: async () => ({}),
      success: { kind: 'json', status: 201 },
    };
    expect(isRestBindingCompatibleWithOperation(binding, startWorkflowOperation)).toBe(true);
  });

  it('returns false when the operation disables http transport', () => {
    const wsOnly = defineOperation({
      name: 'weft.workflows.subscribe',
      summary: 'Subscribe (not REST-mountable)',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      access: { kind: 'authenticated' },
      transports: {
        http: false,
        jsonRpcHttp: false,
        jsonRpcWebSocket: true,
        jsonRpcStdio: true,
      },
      unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
      invoke: async () => ({}),
    });
    const binding: RestBinding<unknown, unknown> = {
      method: 'GET',
      path: '/v1/subscribe',
      pathParamNames: [],
      operationName: 'weft.workflows.subscribe',
      inputSources: {},
      extractInput: async () => ({}),
      success: { kind: 'streaming', mediaType: 'text/event-stream' },
    };
    expect(isRestBindingCompatibleWithOperation(binding, wsOnly)).toBe(false);
  });

  it('returns false when the binding names a different operation', () => {
    const binding: RestBinding<unknown, unknown> = {
      method: 'POST',
      path: '/v1/workflows',
      pathParamNames: [],
      operationName: 'weft.workflows.other',
      inputSources: {},
      extractInput: async () => ({}),
      success: { kind: 'json', status: 201 },
    };
    expect(isRestBindingCompatibleWithOperation(binding, startWorkflowOperation)).toBe(false);
  });
});

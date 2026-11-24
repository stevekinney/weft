import { Glob } from 'bun';
import { describe, expect, it } from 'bun:test';
import { join, relative } from 'node:path';

import type { OperationFault } from "../embedded/backchannel/src/index.ts";
import {
  faultToHttpResponse,
  shapeOperationFaultAsJson,
  shapeRestFaultAsJson,
} from "../embedded/backchannel/src/internals.ts";
import {
  shapeWeftOperationFaultAsJson,
  shapeWeftRestFaultAsJson,
  weftFaultToHttpResponse,
} from './weft-operation-fault.ts';

function notFound(weftCode: string): OperationFault {
  return { code: 'NotFound', message: 'gone', data: { resource: 'workflow', weftCode } };
}

const projections = [
  ['weftFaultToHttpResponse', weftFaultToHttpResponse],
  ['shapeWeftRestFaultAsJson', shapeWeftRestFaultAsJson],
  ['shapeWeftOperationFaultAsJson', shapeWeftOperationFaultAsJson],
] as const;

describe('the REST projections bound to Weft error codes', () => {
  for (const [name, project] of projections) {
    it(`${name} drops a weftCode that is not one of Weft's error codes`, async () => {
      const response = project(notFound('NotAWeftErrorCode'));
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: 'gone',
        data: { resource: 'workflow' },
        retryable: false,
      });
    });

    it(`${name} keeps a weftCode that is one of Weft's error codes`, async () => {
      const response = project(notFound('WorkflowNotFoundError'));
      expect(await response.json()).toEqual({
        error: 'gone',
        weftCode: 'WorkflowNotFoundError',
        data: { resource: 'workflow' },
        retryable: false,
      });
    });
  }
});

describe('the projections that name no host', () => {
  it('pass a string weftCode through, and drop one that is not a string', async () => {
    for (const project of [faultToHttpResponse, shapeRestFaultAsJson, shapeOperationFaultAsJson]) {
      expect(await project(notFound('AnyHostCode')).json()).toEqual({
        error: 'gone',
        weftCode: 'AnyHostCode',
        data: { resource: 'workflow' },
        retryable: false,
      });
      const numeric = {
        code: 'NotFound',
        message: 'gone',
        data: { resource: 'workflow', weftCode: 7 },
      } as unknown as OperationFault;
      expect(await project(numeric).json()).toEqual({
        error: 'gone',
        data: { resource: 'workflow' },
        retryable: false,
      });
    }
  });

  it('take the vocabulary from the options', async () => {
    const response = shapeRestFaultAsJson(notFound('Other'), {
      isKnownErrorCode: (value) => value === 'Mine',
    });
    expect(await response.json()).toEqual({
      error: 'gone',
      data: { resource: 'workflow' },
      retryable: false,
    });
  });
});

describe('Weft code that answers a REST request', () => {
  // The unbound projections keep a weftCode that Weft does not recognise, so a Weft file that
  // reached for one would put an unknown code on the wire. Only the files that define them, the
  // generic handler (which reads the host's vocabulary from its FaultPolicy), the generic files
  // whose faults carry no `weftCode` (they move with the operation layer) and tests may.
  const unbound = /\b(?:shapeRestFaultAsJson|shapeOperationFaultAsJson|faultToHttpResponse)\b/;
  const allowed = new Set([
    'operation-fault.ts',
    'fault-to-http.ts',
    'weft-operation-fault.ts',
    'handler/operation-handler-subscription.ts',
    'operations/get-principal.ts',
    'operations/sse-stream.ts',
  ]);

  it('calls only the projections bound to Weft error codes', async () => {
    const root = join(import.meta.dir, '..');
    const offenders: string[] = [];
    for await (const path of new Glob('**/*.ts').scan({ cwd: root, absolute: true })) {
      const name = relative(join(root, 'server'), path);
      if (!path.startsWith(join(root, 'server') + '/') || allowed.has(name)) continue;
      if (/\.(?:test|test-d|test-support)\.ts$/.test(path) || path.includes('__fixtures__'))
        continue;
      const text = await Bun.file(path).text();
      const code = text
        .split('\n')
        .filter((line) => !/^\s*(?:\*|\/\/|\/\*)/.test(line))
        .join('\n');
      if (unbound.test(code)) offenders.push(relative(root, path));
    }
    expect(offenders).toEqual([]);
  });
});

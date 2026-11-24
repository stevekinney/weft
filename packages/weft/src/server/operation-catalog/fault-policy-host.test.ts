import { WEFT_SCOPE_VOCABULARY } from '../../authorization-scopes.ts';
/**
 * Strict-fault mode belongs to the host (COR-2473): Weft's live registry follows the environment
 * on every undeclared fault, and a handler whose host supplies nothing is strict.
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { z } from 'zod';

import {
  type OperationFault,
  createOperationHandler,
  defineOperation,
  principalFromStdioLocal,
} from "../../embedded/backchannel/src/index.ts";
import { executeOperation } from "../../embedded/backchannel/src/internals.ts";
import { createLiveOperationRegistry } from '../rest-bindings.ts';

const UNDECLARED: OperationFault = {
  code: 'Timeout',
  message: 'too slow',
  data: { operationName: 'probe.undeclared' },
};

const originalNodeEnvironment = Bun.env['NODE_ENV'];
const originalStrictFaults = Bun.env['WEFT_STRICT_FAULTS'];

function setEnvironment(nodeEnvironment: string, strictFaults?: string): void {
  Bun.env['NODE_ENV'] = nodeEnvironment;
  if (strictFaults === undefined) delete Bun.env['WEFT_STRICT_FAULTS'];
  else Bun.env['WEFT_STRICT_FAULTS'] = strictFaults;
}

afterEach(() => {
  if (originalNodeEnvironment === undefined) delete Bun.env['NODE_ENV'];
  else Bun.env['NODE_ENV'] = originalNodeEnvironment;
  if (originalStrictFaults === undefined) delete Bun.env['WEFT_STRICT_FAULTS'];
  else Bun.env['WEFT_STRICT_FAULTS'] = originalStrictFaults;
});

describe('Weft live registry', () => {
  it('follows the environment between two calls on one registry', async () => {
    const registry = createLiveOperationRegistry();
    // `weft.workflows.get` declares `NotFound` only, so a thrown `Timeout` is undeclared.
    const dispatch = () =>
      executeOperation(
        'weft.workflows.get',
        { workflowId: 'wf-1' },
        {
          principal: principalFromStdioLocal(WEFT_SCOPE_VOCABULARY),
          host: {
            get: async () => {
              throw UNDECLARED;
            },
          },
          transport: 'jsonRpcHttp',
          registry,
        },
      );
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      setEnvironment('production');
      const production = await dispatch();
      setEnvironment('test');
      const test = await dispatch();
      setEnvironment('production', '1');
      const forced = await dispatch();

      expect(production).toEqual({ ok: false, fault: UNDECLARED });
      expect(test.ok ? 'passed' : test.fault.code).toBe('EngineFailure');
      expect(forced.ok ? 'passed' : forced.fault.code).toBe('EngineFailure');
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

const undeclaredOperation = defineOperation({
  name: 'probe.undeclared',
  mcpExposable: false,
  summary: 'throws a fault it does not declare',
  destructive: false,
  inputSchema: z.object({}),
  outputSchema: z.object({}),
  access: { kind: 'public' as const },
  transports: { http: false, jsonRpcHttp: true, jsonRpcWebSocket: false, jsonRpcStdio: false },
  unknownKeyPolicy: { http: 'reject' as const, jsonRpc: 'reject' as const },
  invoke: async () => {
    throw UNDECLARED;
  },
});

async function weftCodeOf(handler: (request: Request) => Promise<Response>): Promise<unknown> {
  const response = await handler(
    new Request('http://localhost/jsonrpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'probe.undeclared', params: {} }),
    }),
  );
  const body = (await response.json()) as { error: { data: { weftCode: string } } };
  return body.error.data.weftCode;
}

describe('createOperationHandler', () => {
  it('is strict by default, even in production, and reads no environment variable', async () => {
    const handler = createOperationHandler({ operations: [undeclaredOperation], host: {} });
    setEnvironment('production');
    expect(await weftCodeOf(handler)).toBe('EngineFailure');
    setEnvironment('development', '0');
    expect(await weftCodeOf(handler)).toBe('EngineFailure');
  });

  it('passes an undeclared fault through when strict mode is turned off explicitly', async () => {
    const handler = createOperationHandler({
      operations: [undeclaredOperation],
      host: {},
      faultPolicy: { strict: false },
    });
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      setEnvironment('test', '1');
      expect(await weftCodeOf(handler)).toBe('Timeout');
    } finally {
      warn.mockRestore();
    }
  });
});

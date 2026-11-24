import { WEFT_SCOPE_VOCABULARY } from '../../authorization-scopes.ts';
/**
 * Pins how the dispatch pipeline classifies the three workflow error classes on Weft's live
 * registry, and the `name`, `code` and message text of the error classes the generic dispatch
 * files declare. Written before the fault classification moved behind the host (COR-2473): it
 * holds the merge base's behavior.
 */

import { describe, expect, it } from 'bun:test';

import { principalFromStdioLocal } from "../../embedded/backchannel/src/index.ts";
import {
  executeOperation,
  MalformedRouteParameterError,
  UndeclaredFaultError,
} from "../../embedded/backchannel/src/internals.ts";
import {
  WorkflowAlreadyExistsError,
  WorkflowNotFoundError,
  WorkflowNotRegisteredError,
} from '../../core/engine/errors.ts';
import { createLiveOperationRegistry } from '../rest-bindings.ts';

async function faultOf(thrown: Error) {
  const result = await executeOperation(
    'weft.workflows.get',
    { workflowId: 'wf-1' },
    {
      principal: principalFromStdioLocal(WEFT_SCOPE_VOCABULARY),
      host: {
        get: async () => {
          throw thrown;
        },
      },
      transport: 'jsonRpcHttp',
      registry: createLiveOperationRegistry(),
    },
  );
  if (result.ok) throw new Error('expected a fault');
  return result.fault;
}

describe('workflow errors thrown by an operation on the live registry', () => {
  it('WorkflowAlreadyExistsError answers Conflict', async () => {
    expect(await faultOf(new WorkflowAlreadyExistsError('wf-1'))).toEqual({
      code: 'Conflict',
      message: 'conflict',
      data: { reason: 'resource already exists' },
    });
  });

  it('WorkflowNotRegisteredError answers InvalidParams with its own message', async () => {
    const error = new WorkflowNotRegisteredError('missing-type');
    expect(await faultOf(error)).toEqual({
      code: 'InvalidParams',
      message: error.message,
      data: { issues: [] },
    });
  });

  it('WorkflowNotFoundError answers NotFound', async () => {
    expect(await faultOf(new WorkflowNotFoundError('wf-1'))).toEqual({
      code: 'NotFound',
      message: 'not found',
      data: { resource: 'workflow' },
    });
  });
});

describe('error classes of the generic dispatch files', () => {
  it('UndeclaredFaultError keeps its name, code and message', () => {
    const error = new UndeclaredFaultError('weft.test.operation', 'NotFound');
    expect(error.name).toBe('UndeclaredFaultError');
    expect(error.code).toBe('UndeclaredFaultError');
    expect(error.message).toBe(
      '[weft] Operation "weft.test.operation" raised undeclared fault "NotFound". ' +
        "Add it to the operation's `producibleFaults` array or migrate the throw to " +
        '`raiseFault(operation, fault)`.',
    );
    expect(error.operationName).toBe('weft.test.operation');
    expect(error.faultCode).toBe('NotFound');
  });

  it('MalformedRouteParameterError keeps its name, code and message', () => {
    const error = new MalformedRouteParameterError();
    expect(error.name).toBe('MalformedRouteParameterError');
    expect(error.code).toBe('MalformedRouteParameterError');
    expect(error.message).toBe('Malformed route parameter encoding');
  });
});

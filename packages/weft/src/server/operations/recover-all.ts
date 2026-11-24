import { z } from 'zod';

import { type OperationFault, defineOperation } from "../../embedded/backchannel/src/index.ts";
import type { UnknownRestBinding } from "../../embedded/backchannel/src/internals.ts";
import { WorkflowTypeNotRegisteredForRecoveryError } from '../../core/engine.ts';
import { assertOperationEngineMethods, shapeRestFault } from './operation-helpers.ts';

// Intentionally accept no input fields. `acknowledgeUnknownWorkflowTypes` is
// the dangerous opt-out that lets recovery silently skip unknown stored
// workflow types — exposing it on this operation would let any caller holding
// `workflows:admin` abandon in-flight workflows over HTTP. The
// in-process flag is still available via `engine.recoverAll(...)` for code
// paths that have already established the operator's intent.
const recoverAllInput = z.object({});

const recoverAllOutput = z.object({
  recovered: z.array(z.string()),
});

export type RecoverAllInput = z.infer<typeof recoverAllInput>;
export type RecoverAllOutput = z.infer<typeof recoverAllOutput>;

export const recoverAllOperation = defineOperation({
  name: 'weft.recover.all',
  mcpExposable: false,
  summary: 'Recover all interrupted workflows',
  description:
    'Re-drive every workflow the engine finds interrupted in storage from its ' +
    'persisted checkpoint, returning the ids it resumed. Takes no input. Faults with ' +
    'Conflict when stored workflows belong to a type this engine has not registered; ' +
    'the fault data names the missing types.',
  destructive: true,
  tags: ['System'],
  inputSchema: recoverAllInput,
  outputSchema: recoverAllOutput,
  access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['workflows:admin'] } },
  discoverable: true,
  producibleFaults: ['Conflict'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ host: engine }): Promise<RecoverAllOutput> => {
    assertOperationEngineMethods(engine, ['recoverAll']);
    const typedEngine = engine;

    try {
      const handles = await typedEngine.recoverAll();
      return { recovered: handles.map((handle) => handle.id) };
    } catch (error) {
      if (error instanceof WorkflowTypeNotRegisteredForRecoveryError) {
        const fault: OperationFault = {
          code: 'Conflict',
          message: error.message,
          data: {
            reason: error.message,
            missingTypes: error.missingTypes,
            missingWorkflowCount: error.missingWorkflowCount,
            samplesTruncated: error.samplesTruncated,
          },
        };
        throw fault;
      }
      const message = error instanceof Error ? error.message : String(error);
      const fault: OperationFault = {
        code: 'EngineFailure',
        message,
        data: {},
      };
      throw fault;
    }
  },
});

export const recoverAllRestBinding: UnknownRestBinding = {
  method: 'POST',
  path: '/v1/recover',
  pathParamNames: [],
  operationName: 'weft.recover.all',
  inputSources: {},
  extractInput: async () => ({}),
  success: { kind: 'json', status: 200 },
  shapeFault: shapeRecoverAllFault,
};

function shapeRecoverAllFault(fault: OperationFault): Response {
  if (fault.code !== 'Conflict' || fault.data.missingTypes === undefined) {
    return shapeRestFault(fault);
  }

  return shapeRestFault(fault, { message: 'workflow_type_not_registered_for_recovery' });
}

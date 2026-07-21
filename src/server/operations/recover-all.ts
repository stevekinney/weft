import { z } from 'zod';

import type { Engine } from '../../core/engine.ts';
import { WorkflowTypeNotRegisteredForRecoveryError } from '../../core/engine.ts';
import { shapeRestFaultBody, type OperationFault } from '../operation-fault.ts';
import { defineOperation } from '../operation-registry.ts';
import type { UnknownRestBinding } from '../rest-bindings.ts';
import { shapeRestFault } from './operation-helpers.ts';

// Intentionally accept no input fields. `acknowledgeUnknownWorkflowTypes` is
// the dangerous opt-out that lets recovery silently skip unknown stored
// workflow types — exposing it on this `kind: 'public'` operation would let
// an unauthenticated caller abandon in-flight workflows over HTTP. The
// in-process flag is still available via `engine.recoverAll(...)` for code
// paths that have already established the operator's intent.
const recoverAllInput = z.object({});

const recoverAllOutput = z.object({
  recovered: z.array(z.string()),
});

export type RecoverAllInput = z.infer<typeof recoverAllInput>;
export type RecoverAllOutput = z.infer<typeof recoverAllOutput>;

export const recoverAllOperation = defineOperation<RecoverAllInput, RecoverAllOutput>({
  name: 'weft.recover.all',
  mcpExposable: false,
  summary: 'Recover all interrupted workflows',
  destructive: true,
  tags: ['System'],
  inputSchema: recoverAllInput,
  outputSchema: recoverAllOutput,
  access: { kind: 'public' },
  producibleFaults: ['Conflict'],
  transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ engine }): Promise<RecoverAllOutput> => {
    const typedEngine = engine as Engine;

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

  return new Response(
    JSON.stringify({
      ...shapeRestFaultBody(fault, 'workflow_type_not_registered_for_recovery'),
      missingTypes: fault.data.missingTypes,
      missingWorkflowCount: fault.data.missingWorkflowCount,
      samplesTruncated: fault.data.samplesTruncated,
    }),
    {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

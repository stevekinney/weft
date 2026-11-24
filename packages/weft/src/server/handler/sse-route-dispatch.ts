import {
  principalFromStdioLocal,
  type OperationFault,
  type Principal,
} from "../../embedded/backchannel/src/index.ts";
import {
  executeOperation,
  isAuthenticated,
  type ConnectionLease,
  type OpenApiSecuritySchemeName,
  type OperationRegistry,
  type PipelineTrace,
  type UnknownRestBinding,
} from "../../embedded/backchannel/src/internals.ts";
import { WEFT_SCOPE_VOCABULARY } from '../../authorization-scopes.ts';
import type { FleetEventFeed } from '../fleet-event-feed.ts';
import { fleetEventsSseOperation } from '../operations/fleet-events-sse.ts';
import {
  workflowEventsSseOperation,
  type WorkflowStreamConnectionAcquirer,
} from '../operations/workflow-events-sse.ts';
import { weftFaultToHttpResponse } from '../weft-operation-fault.ts';
import type { WorkflowEventFeed } from '../workflow-event-feed.ts';

export type LiveEventStreamContext = {
  workflowEventFeed?: WorkflowEventFeed;
  fleetEventFeed?: Pick<FleetEventFeed, 'subscribe'>;
  acquireWorkflowStreamConnection?: WorkflowStreamConnectionAcquirer;
  acquireFleetEventSubscriber?: () => ConnectionLease;
  acquireWorkflowEventSubscriber?: () => ConnectionLease;
};

type DispatchServerSentEventsBindingOptions = {
  readonly request: Request;
  readonly binding: UnknownRestBinding;
  readonly rawInput: unknown;
  readonly principal: Principal;
  readonly registry: OperationRegistry;
  readonly pipelineTrace?: PipelineTrace;
  readonly supportedAuthenticationSchemes?: ReadonlySet<OpenApiSecuritySchemeName>;
  readonly liveEventStreamContext?: LiveEventStreamContext;
};

export function isDirectServerSentEventsOperation(operationName: string): boolean {
  return (
    operationName === workflowEventsSseOperation.name ||
    operationName === fleetEventsSseOperation.name
  );
}

export async function dispatchServerSentEventsBinding(
  options: DispatchServerSentEventsBindingOptions,
): Promise<Response> {
  const { binding, registry } = options;
  const missingOperationResponse = shapeMissingOperation(binding, registry);
  if (missingOperationResponse !== null) return missingOperationResponse;

  const shapeSuccess = binding.shapeSuccess;
  if (shapeSuccess === undefined) throw new Error('SSE binding missing success shaper');

  const result = await executeOperation(binding.operationName, options.rawInput, {
    principal: principalForServerSentEvents(options),
    host: options.liveEventStreamContext ?? {},
    transport: 'http-rest',
    registry,
    signal: options.request.signal,
    ...(options.pipelineTrace === undefined ? {} : { pipelineTrace: options.pipelineTrace }),
  });
  if (result.ok) return shapeSuccess(result.value, options.request);
  return binding.shapeFault
    ? binding.shapeFault(result.fault)
    : weftFaultToHttpResponse(result.fault);
}

function shapeMissingOperation(
  binding: UnknownRestBinding,
  registry: OperationRegistry,
): Response | null {
  if (registry.get(binding.operationName) !== undefined) return null;
  const fault: OperationFault = {
    code: 'MethodNotFound',
    message: `unknown operation: ${binding.operationName}`,
    data: { method: binding.operationName },
  };
  return binding.shapeFault ? binding.shapeFault(fault) : weftFaultToHttpResponse(fault);
}

function principalForServerSentEvents(options: DispatchServerSentEventsBindingOptions): Principal {
  if (options.supportedAuthenticationSchemes?.size === 0 && !isAuthenticated(options.principal)) {
    return principalFromStdioLocal(WEFT_SCOPE_VOCABULARY);
  }
  return options.principal;
}

import type { FaultCode } from "../embedded/backchannel/src/index.ts";
import { FAULT_CODE_RETRYABLE, remediationProblem } from "../embedded/backchannel/src/internals.ts";
import type { Engine } from '../core/engine.ts';
import { RegistrySchemaConversionError } from '../core/registry-snapshot.ts';
import { runtimeWorkflowEngine } from '../core/runtime-workflow-engine.ts';
import { definitionSchemaToJsonSchema } from '../core/types/definition-schema-to-json.ts';
import type { DefinitionSchema } from '../core/types/definition-schema.ts';
import { weftFaultPolicy } from '../server/weft-fault-policy.ts';
import {
  McpToolExecutionError,
  assertScope,
  getVisibleWorkflowState,
  listVisibleWorkflows,
  type McpAccessContext,
} from './access.ts';
import { parseMcpListFilter } from './list-filter.ts';
import { tupleListsEqual } from './tuple-list-equality.ts';

/** MCP tool definition. */
export type McpToolDefinition = {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
};

/**
 * What a failed tool call reports as `structuredContent`: the same fields as every other Weft
 * surface's fault. `retryable` is the code's own answer, and `remediation` is one line saying what
 * to do next, when there is something to say.
 */
type McpToolFault = {
  readonly code: FaultCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly remediation?: string;
};

/**
 * Result shape returned by MCP `tools/call`. A failure keeps its message as text, so a host that
 * ignores `structuredContent` still reads it, and carries the {@link McpToolFault} beside it.
 */
export type McpToolResult = {
  readonly content: ReadonlyArray<{ readonly type: 'text'; readonly text: string }>;
  readonly isError?: boolean;
  readonly structuredContent?: McpToolFault;
};

/**
 * What a tool call runs with: the caller's access context and the abort signal
 * of the MCP request that carries it. The SDK aborts the signal when the client
 * cancels the request, and a workflow tool cancels the workflow it started.
 */
export type McpToolCallContext = McpAccessContext & {
  readonly signal?: AbortSignal | undefined;
  /**
   * Receives work a call starts and does not await, such as cancelling the workflow of a call the
   * client cancelled, so the entry that owns the connection can wait for it before closing.
   */
  readonly trackPendingWork?: ((work: Promise<unknown>) => void) | undefined;
};

type ToolImplementation = {
  readonly definition: McpToolDefinition;
  readonly call: (argumentsValue: unknown, context: McpToolCallContext) => Promise<unknown>;
};

type ToolRegistrySignatureEntry = readonly [
  type: string,
  description: string | undefined,
  inputSchema: unknown,
];

type ToolRegistry = {
  readonly signature: ReadonlyArray<ToolRegistrySignatureEntry>;
  readonly tools: ReadonlyArray<ToolImplementation>;
  readonly toolsByName: ReadonlyMap<string, ToolImplementation>;
};

type WorkflowToolArguments = {
  readonly input: unknown;
  readonly timeoutMs: number;
};

type WorkflowToolResultWaitOutcome =
  { readonly status: 'completed'; readonly result: unknown } | { readonly status: 'timed-out' };

type ResultHandle = {
  readonly id: string;
  result(): Promise<unknown>;
};

const toolRegistryCache = new WeakMap<Engine, ToolRegistry>();
const DEFAULT_WORKFLOW_TOOL_TIMEOUT_MS = 30_000;
const MAX_WORKFLOW_TOOL_TIMEOUT_MS = 2_147_483_647;

/** Build deterministic MCP tool definitions for the current engine registry. */
export function listMcpTools(engine: Engine): McpToolDefinition[] {
  return getToolRegistry(engine).tools.map((tool) => tool.definition);
}

/** Invoke an MCP tool and shape application failures as tool errors. */
export async function callMcpTool(
  name: string,
  argumentsValue: unknown,
  context: McpToolCallContext,
): Promise<McpToolResult> {
  const tool = getToolRegistry(context.engine).toolsByName.get(name);
  if (tool === undefined) {
    return toolError(
      toolFault(
        'MethodNotFound',
        `Unknown tool: ${name}`,
        'Call tools/list for the tools this server offers',
      ),
    );
  }

  try {
    const value = await tool.call(argumentsValue ?? {}, context);
    return toolSuccess(value);
  } catch (error) {
    if (error instanceof McpToolExecutionError) {
      return toolError(toolFault(error.faultCode, error.message, error.remediation));
    }
    if (error instanceof Error && error.message === WORKFLOW_CANCELLED_MESSAGE) {
      return toolError(toolFault('Conflict', error.message));
    }
    const classified = classifyEngineToolError(error);
    if (classified !== undefined) return toolError(classified);
    console.warn('MCP tool execution failed:', error);
    return toolError(toolFault('EngineFailure', 'Tool execution failed'));
  }
}

const WORKFLOW_CANCELLED_MESSAGE = 'Workflow cancelled';

/** A cancelled workflow or request: the call cannot finish as asked, and repeating it is not the repair. */
function workflowCancelledError(): McpToolExecutionError {
  return new McpToolExecutionError(WORKFLOW_CANCELLED_MESSAGE, { faultCode: 'Conflict' });
}

/**
 * The fault of an engine error whose class Weft's fault policy names (an id already taken, a
 * workflow type that is not registered, a workflow that does not exist), with the caller's own
 * input in its message. Any other error is masked by the caller: its message may hold internals.
 */
function classifyEngineToolError(error: unknown): McpToolFault | undefined {
  const classified = weftFaultPolicy.classifyError?.(error);
  if (classified === undefined || !(error instanceof Error)) return undefined;
  switch (classified.code) {
    case 'Conflict':
      return toolFault(
        'Conflict',
        error.message,
        'Choose a different id, or omit id to let the engine generate one',
      );
    case 'InvalidParams':
      return toolFault(
        'InvalidParams',
        error.message,
        'Use a workflow type that is registered on this engine',
      );
    case 'NotFound':
      return toolFault(
        'NotFound',
        error.message,
        'Call list_workflows to find a workflow id that exists',
      );
    default:
      return undefined;
  }
}

function getToolRegistry(engine: Engine): ToolRegistry {
  const signature = toolRegistrySignature(engine);
  const cached = toolRegistryCache.get(engine);
  if (cached !== undefined && toolRegistrySignaturesEqual(cached.signature, signature)) {
    return cached;
  }

  const tools = buildToolImplementations(engine);
  const registry = {
    signature,
    tools,
    toolsByName: new Map(tools.map((tool) => [tool.definition.name, tool])),
  };
  toolRegistryCache.set(engine, registry);
  return registry;
}

function toolRegistrySignature(engine: Engine): ToolRegistrySignatureEntry[] {
  return engine
    .listWorkflowDefinitions()
    .toSorted((left, right) => (left.type < right.type ? -1 : left.type > right.type ? 1 : 0))
    .map(
      (definition) => [definition.type, definition.description, definition.inputSchema] as const,
    );
}

function toolRegistrySignaturesEqual(
  left: ReadonlyArray<ToolRegistrySignatureEntry>,
  right: ReadonlyArray<ToolRegistrySignatureEntry>,
): boolean {
  return tupleListsEqual(
    left,
    right,
    (leftEntry, rightEntry) =>
      leftEntry[0] === rightEntry[0] &&
      leftEntry[1] === rightEntry[1] &&
      leftEntry[2] === rightEntry[2],
  );
}

function buildToolImplementations(engine: Engine): ToolImplementation[] {
  const tools = [...builtInTools()];
  const usedNames = new Set(tools.map((tool) => tool.definition.name));
  for (const definition of engine
    .listWorkflowDefinitions()
    .toSorted((left, right) => (left.type < right.type ? -1 : left.type > right.type ? 1 : 0))) {
    if (definition.inputSchema === undefined) continue;
    const name = uniqueToolName(toolNameFromWorkflowType(definition.type), usedNames);
    usedNames.add(name);
    tools.push({
      definition: {
        name,
        title: definition.type,
        description: definition.description ?? `Run Weft workflow ${definition.type}.`,
        inputSchema: convertWorkflowInputSchema(definition.type, definition.inputSchema),
      },
      call: async (argumentsValue, context) => {
        assertScope(context, 'workflows:write', 'Calling workflow tools');
        const { input, timeoutMs } = parseWorkflowToolArguments(argumentsValue);
        if (context.signal?.aborted) throw workflowCancelledError();
        const handle = await runtimeWorkflowEngine(context.engine).start(definition.type, input, {
          id: crypto.randomUUID(),
        });
        const outcome = await waitForWorkflowToolResult(handle, {
          timeoutMs,
          signal: context.signal,
          cancel: async () => {
            await context.engine.cancel(handle.id);
          },
          trackPendingWork: context.trackPendingWork,
        });
        if (outcome.status === 'timed-out') {
          return workflowToolStillRunningResult(handle.id, timeoutMs);
        }
        return { workflowId: handle.id, result: outcome.result };
      },
    });
  }

  return tools.toSorted((left, right) => (left.definition.name < right.definition.name ? -1 : 1));
}

function convertWorkflowInputSchema(
  workflowType: string,
  schema: DefinitionSchema,
): Record<string, unknown> {
  try {
    return withWorkflowToolTimeoutParameter(definitionSchemaToJsonSchema(schema, 'input'));
  } catch (cause) {
    throw new RegistrySchemaConversionError('workflow', workflowType, 'inputSchema', cause);
  }
}

function withWorkflowToolTimeoutParameter(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['input'],
    properties: {
      input: schema,
      timeoutMs: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_WORKFLOW_TOOL_TIMEOUT_MS,
        default: DEFAULT_WORKFLOW_TOOL_TIMEOUT_MS,
        description:
          'Maximum milliseconds to wait for the workflow result before returning a running status.',
      },
    },
  };
}

function parseWorkflowToolArguments(argumentsValue: unknown): WorkflowToolArguments {
  const record = requireObject(argumentsValue);
  const timeoutMs = parseWorkflowToolTimeoutMs(record['timeoutMs']);
  return { input: record['input'], timeoutMs };
}

function parseWorkflowToolTimeoutMs(value: unknown): number {
  if (value === undefined) return DEFAULT_WORKFLOW_TOOL_TIMEOUT_MS;
  if (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_WORKFLOW_TOOL_TIMEOUT_MS
  ) {
    return value;
  }
  throw new McpToolExecutionError(
    `Tool argument "timeoutMs" must be an integer from 1 to ${MAX_WORKFLOW_TOOL_TIMEOUT_MS}`,
  );
}

async function waitForWorkflowToolResult(
  handle: ResultHandle,
  options: {
    timeoutMs: number;
    signal?: AbortSignal | undefined;
    cancel: () => Promise<void>;
    trackPendingWork?: ((work: Promise<unknown>) => void) | undefined;
  },
): Promise<WorkflowToolResultWaitOutcome> {
  if (options.signal?.aborted) {
    await options.cancel();
    throw workflowCancelledError();
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let cleanupAbortListener: (() => void) | undefined;
  const resultPromise = handle
    .result()
    .then((result) => ({ status: 'completed', result }) as const);
  const timeoutPromise = new Promise<WorkflowToolResultWaitOutcome>((resolve) => {
    timeout = setTimeout(() => resolve({ status: 'timed-out' }), options.timeoutMs);
  });
  const cancellationPromise =
    options.signal === undefined
      ? undefined
      : new Promise<never>((_resolve, reject) => {
          const abort = () => {
            reject(workflowCancelledError());
            const cancellation = options.cancel().catch((error: unknown) => {
              console.warn('MCP workflow tool cancellation failed:', error);
            });
            options.trackPendingWork?.(cancellation);
          };
          options.signal?.addEventListener('abort', abort, { once: true });
          cleanupAbortListener = () => options.signal?.removeEventListener('abort', abort);
        });

  try {
    return await Promise.race(
      cancellationPromise === undefined
        ? [resultPromise, timeoutPromise]
        : [resultPromise, timeoutPromise, cancellationPromise],
    );
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    cleanupAbortListener?.();
  }
}

function workflowToolStillRunningResult(
  workflowId: string,
  timeoutMs: number,
): Record<string, unknown> {
  return {
    workflowId,
    status: 'running',
    timedOut: true,
    timeoutMs,
    message:
      'Workflow is still running and was not cancelled. Call get_workflow_state with this workflowId to poll for completion.',
    followUp: {
      tool: 'get_workflow_state',
      arguments: { workflowId },
    },
  };
}

function builtInTools(): ToolImplementation[] {
  return [
    {
      definition: {
        name: 'start_workflow',
        description: 'Start a Weft workflow and return its workflow id.',
        inputSchema: objectSchema(
          {
            type: { type: 'string' },
            input: {},
            id: { type: 'string' },
          },
          ['type'],
        ),
      },
      call: async (argumentsValue, context) => {
        assertScope(context, 'workflows:write', 'Starting workflows');
        const args = requireObject(argumentsValue);
        const type = requireString(args['type'], 'type');
        const input = args['input'] ?? {};
        const options = typeof args['id'] === 'string' ? { id: args['id'] } : undefined;
        const handle = await runtimeWorkflowEngine(context.engine).start(type, input, options);
        return { workflowId: handle.id };
      },
    },
    {
      definition: {
        name: 'signal_workflow',
        description: 'Send a signal to a Weft workflow.',
        inputSchema: objectSchema(
          {
            workflowId: { type: 'string' },
            signalName: { type: 'string' },
            payload: {},
          },
          ['workflowId', 'signalName'],
        ),
      },
      call: async (argumentsValue, context) => {
        assertScope(context, 'signals:write', 'Signalling workflows');
        const args = requireObject(argumentsValue);
        const workflowId = requireString(args['workflowId'], 'workflowId');
        await requireVisibleWorkflow(context, workflowId);
        await context.engine.signal(
          workflowId,
          requireString(args['signalName'], 'signalName'),
          args['payload'],
        );
        return { ok: true };
      },
    },
    {
      definition: {
        name: 'update_workflow',
        description: 'Run an update handler on a Weft workflow.',
        inputSchema: objectSchema(
          {
            workflowId: { type: 'string' },
            updateName: { type: 'string' },
            payload: {},
          },
          ['workflowId', 'updateName'],
        ),
      },
      call: async (argumentsValue, context) => {
        assertScope(context, 'updates:write', 'Updating workflows');
        const args = requireObject(argumentsValue);
        const workflowId = requireString(args['workflowId'], 'workflowId');
        await requireVisibleWorkflow(context, workflowId);
        const result = await context.engine.update(
          workflowId,
          requireString(args['updateName'], 'updateName'),
          args['payload'],
        );
        return { result };
      },
    },
    {
      definition: {
        name: 'query_workflow',
        description: 'Run a query handler on a Weft workflow.',
        inputSchema: objectSchema(
          {
            workflowId: { type: 'string' },
            queryName: { type: 'string' },
            input: {},
          },
          ['workflowId', 'queryName'],
        ),
      },
      call: async (argumentsValue, context) => {
        assertScope(context, 'queries:read', 'Querying workflows');
        const args = requireObject(argumentsValue);
        const workflowId = requireString(args['workflowId'], 'workflowId');
        await requireVisibleWorkflow(context, workflowId);
        const result = await context.engine.query(
          workflowId,
          requireString(args['queryName'], 'queryName'),
          args['input'],
        );
        return { result };
      },
    },
    {
      definition: {
        name: 'cancel_workflow',
        description: 'Cancel a Weft workflow.',
        inputSchema: objectSchema({ workflowId: { type: 'string' } }, ['workflowId']),
      },
      call: async (argumentsValue, context) => {
        assertScope(context, 'workflows:write', 'Cancelling workflows');
        const workflowId = requireString(requireObject(argumentsValue)['workflowId'], 'workflowId');
        await requireVisibleWorkflow(context, workflowId);
        await context.engine.cancel(workflowId);
        return { ok: true };
      },
    },
    {
      definition: {
        name: 'list_workflows',
        description: 'List visible Weft workflows.',
        inputSchema: objectSchema({
          status: {},
          type: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          limit: { type: 'number' },
          offset: { type: 'number' },
          failedStep: { type: 'string', minLength: 1 },
          retrying: { type: 'boolean' },
        }),
      },
      call: async (argumentsValue, context) => {
        assertScope(context, 'workflows:read', 'Listing workflows');
        const parsed = parseMcpListFilter(requireObject(argumentsValue));
        if (!parsed.ok) throw new McpToolExecutionError(parsed.message);
        const result = await listVisibleWorkflows(context.engine, parsed.filter);
        return result;
      },
    },
    {
      definition: {
        name: 'get_workflow_state',
        description: 'Read visible Weft workflow state.',
        inputSchema: objectSchema({ workflowId: { type: 'string' } }, ['workflowId']),
      },
      call: async (argumentsValue, context) => {
        assertScope(context, 'workflows:read', 'Reading workflow state');
        const workflowId = requireString(requireObject(argumentsValue)['workflowId'], 'workflowId');
        return await requireVisibleWorkflow(context, workflowId);
      },
    },
  ];
}

async function requireVisibleWorkflow(context: McpAccessContext, workflowId: string) {
  const state = await getVisibleWorkflowState(context.engine, workflowId);
  if (state === null) {
    throw new McpToolExecutionError(`Workflow "${workflowId}" not found`, {
      faultCode: 'NotFound',
      remediation: 'Call list_workflows to find a workflow id that exists',
    });
  }
  return state;
}

function toolSuccess(value: unknown): McpToolResult {
  return { isError: false, content: [{ type: 'text', text: JSON.stringify(value) }] };
}

/** The fault of `code`: `retryable` from the code's single table, `remediation` only when valid. */
function toolFault(code: FaultCode, message: string, remediation?: string): McpToolFault {
  return {
    code,
    message,
    retryable: FAULT_CODE_RETRYABLE[code],
    ...(remediation === undefined || remediationProblem(remediation) !== undefined
      ? {}
      : { remediation }),
  };
}

function toolError(fault: McpToolFault): McpToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: fault.message }],
    structuredContent: fault,
  };
}

function requireObject(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new McpToolExecutionError('Tool arguments must be a JSON object');
}

function requireString(value: unknown, field: string): string {
  if (typeof value === 'string' && value.length > 0) return value;
  throw new McpToolExecutionError(`Tool argument "${field}" must be a non-empty string`);
}

function objectSchema(
  properties: Record<string, unknown>,
  required: ReadonlyArray<string> = [],
): Record<string, unknown> {
  return {
    type: 'object',
    properties,
    required: [...required],
    additionalProperties: false,
  };
}

function toolNameFromWorkflowType(workflowType: string): string {
  const normalized = workflowType
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '_')
    .replaceAll(/^_+|_+$/g, '');
  if (/^[a-z][a-z0-9_]*$/.test(normalized)) return normalized;
  return `workflow_${normalized || 'unnamed'}`;
}

function uniqueToolName(baseName: string, usedNames: ReadonlySet<string>): string {
  if (!usedNames.has(baseName)) return baseName;
  let suffix = 2;
  while (usedNames.has(`${baseName}_${String(suffix)}`)) suffix += 1;
  return `${baseName}_${String(suffix)}`;
}

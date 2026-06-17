import type { z } from 'zod';

import type { DefinitionSchemaDirection } from '../core/types/definition-schema-to-json.ts';
import { compareStrings } from './json-schema-utilities.ts';
import type { ErasedOperation } from './operation-catalog.ts';
import { externalApiPath } from './route-model.ts';

const JSON_RPC_VERSION = '2.0';
const EVENT_DELIVER_METHOD = 'weft.events.deliver';
const EVENTS_TERMINATED_METHOD = 'weft.events.terminated';
const WORKFLOW_SUBSCRIPTION_OPERATION_NAME = 'weft.workflows.events';
const WORKFLOW_SUBSCRIPTION_REQUEST_METHOD = 'weft.workflows.subscribe';
const UNSUBSCRIBE_METHOD = 'weft.workflows.unsubscribe';

// Accepts string | number for normal request/response correlation, plus
// `null` because the WebSocket handler emits `id: request.id ?? null` for
// JSON-RPC error responses to malformed frames where no caller id is known.
const JSON_RPC_ID_SCHEMA: Record<string, unknown> = {
  oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }],
};

// Mirrors the exact reason strings emitted by `json-rpc-websocket.ts`.
// Adding entries here without an emit site (or removing one without
// updating the emitter) makes `/asyncapi.json` lie about the wire.
// `engine-error` and `overflow` were specified speculatively but the
// session collapses both cases into `server-closed` (with a `fault`
// payload), so they are intentionally absent from this enum.
const SUBSCRIPTION_TERMINATION_REASON_SCHEMA: Record<string, unknown> = {
  enum: ['client-unsubscribed', 'server-closed', 'validation-failed'],
  type: 'string',
};

type WebSocketMessageNames = {
  readonly subscribeRequest: string;
  readonly subscribeAck: string;
  readonly eventDeliver: string;
  readonly unsubscribeRequest: string;
  readonly terminated: string;
  readonly errorFrame: string;
};

type SseMessageNames = {
  readonly tokenEvent: string;
  readonly doneEvent: string;
  readonly errorEvent: string;
};

/**
 * Build the AsyncAPI channel object for a WebSocket subscription operation.
 */
export function buildWebSocketChannel(operation: ErasedOperation): Record<string, unknown> {
  const messageNames = webSocketMessageNames(operation);
  return {
    // External wire address: the JSON-RPC WebSocket is served under the `/api`
    // prefix. Internal routing matches the canonical `/jsonrpc` after the front
    // door strips the prefix.
    address: externalApiPath('/jsonrpc'),
    bindings: {
      ws: {
        method: 'GET',
      },
    },
    description: `JSON-RPC WebSocket subscription channel for ${operation.name}.`,
    messages: messageReferenceMap(messageNames),
    title: operation.summary,
    'x-weft-operation-name': operation.name,
    'x-weft-transport': 'json-rpc-websocket',
  };
}

/**
 * Build the AsyncAPI channel object for an SSE stream operation.
 *
 * `restBindingPath` MUST be the operation's REST binding path translated to
 * OpenAPI path-parameter syntax (e.g. `/v1/workflows/{id}/sse`). Without it
 * the channel address falls back to a synthetic dotted-name-to-path
 * conversion that does not match any wire endpoint — kept only as a
 * non-failing default so a misconfigured registry produces a recognizable
 * synthetic address rather than throwing during document generation.
 */
export function buildSseChannel(
  operation: ErasedOperation,
  restBindingPath: string | undefined,
): Record<string, unknown> {
  const messageNames = sseMessageNames(operation);
  // Real REST binding paths are served under `/api`; the synthetic
  // unbound-fallback is not a wire endpoint, so it is left unprefixed.
  const address =
    restBindingPath !== undefined
      ? externalApiPath(restBindingPath)
      : `/x-weft-unbound/${operation.name.replaceAll('.', '/')}`;
  return {
    address,
    description:
      `Server-Sent Events stream channel for ${operation.name}. ` +
      'Responses use text/event-stream; charset=utf-8.',
    messages: messageReferenceMap(messageNames),
    title: operation.summary,
    'x-weft-operation-name': operation.name,
    'x-weft-transport': 'server-sent-events',
  };
}

/**
 * Build named component messages for a WebSocket subscription operation.
 */
export function buildWebSocketMessages(
  operation: ErasedOperation,
  definitionSchemaToJsonSchema: (
    schema: z.ZodType,
    direction?: DefinitionSchemaDirection,
  ) => Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const names = webSocketMessageNames(operation);
  const inputSchema = definitionSchemaToJsonSchema(operation.inputSchema);
  const outputSchema = definitionSchemaToJsonSchema(operation.outputSchema, 'output');
  const eventSchema = eventJsonSchema(operation, definitionSchemaToJsonSchema);

  return {
    [names.subscribeRequest]: {
      name: names.subscribeRequest,
      contentType: 'application/json',
      payload: jsonRpcRequestPayload(subscriptionRequestMethod(operation), inputSchema),
      summary: `Subscribe to ${operation.name}.`,
    },
    [names.subscribeAck]: {
      name: names.subscribeAck,
      contentType: 'application/json',
      payload: jsonRpcSuccessPayload(outputSchema),
      summary: `Subscription acknowledgement for ${operation.name}.`,
    },
    [names.eventDeliver]: {
      name: names.eventDeliver,
      contentType: 'application/json',
      payload: eventDeliverPayload(eventSchema),
      summary: `Event delivery notification for ${operation.name}.`,
    },
    [names.unsubscribeRequest]: {
      name: names.unsubscribeRequest,
      contentType: 'application/json',
      payload: jsonRpcRequestPayload(UNSUBSCRIBE_METHOD, {
        additionalProperties: false,
        properties: {
          subscriptionId: { type: 'string' },
        },
        required: ['subscriptionId'],
        type: 'object',
      }),
      summary: `Unsubscribe from ${operation.name}.`,
    },
    [names.terminated]: {
      name: names.terminated,
      contentType: 'application/json',
      payload: terminatedPayload(),
      summary: `Subscription termination notification for ${operation.name}.`,
    },
    [names.errorFrame]: {
      name: names.errorFrame,
      contentType: 'application/json',
      payload: jsonRpcErrorPayload(),
      summary: `JSON-RPC error response for ${operation.name}.`,
    },
  };
}

/**
 * Build named component messages for an SSE stream operation.
 *
 * The token message's `data:` line carries the operation's wire-encoded
 * token text — for the only SSE operation today (`weft.workflows.streams.sse`)
 * that is the raw `token` string from `mapTokenChunkToText`, NOT a JSON
 * encoding of the operation's `eventSchema`. The `eventSchema` describes
 * the logical per-element type for non-SSE callers (JSON-RPC envelopes
 * carry the full object); SSE is a separate, plain-text wire.
 *
 * The schema below reflects the actual SSE wire. The `x-weft-event-schema`
 * extension surfaces the logical schema for clients that need it.
 */
export function buildSseMessages(
  operation: ErasedOperation,
  definitionSchemaToJsonSchema: (
    schema: z.ZodType,
    direction?: DefinitionSchemaDirection,
  ) => Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const names = sseMessageNames(operation);
  const logicalEventSchema = eventJsonSchema(operation, definitionSchemaToJsonSchema);

  return {
    [names.tokenEvent]: {
      name: names.tokenEvent,
      contentType: 'text/event-stream',
      payload: { type: 'string' },
      summary: `SSE token event for ${operation.name}. The data: line carries the token text.`,
      bindings: {
        http: {
          event: 'token',
        },
      },
      'x-weft-sse-frame': 'event: token\\nid: <sequence>\\ndata: <token-text>\\n\\n',
      'x-weft-event-schema': logicalEventSchema,
    },
    [names.doneEvent]: {
      name: names.doneEvent,
      contentType: 'text/event-stream',
      payload: {
        additionalProperties: false,
        properties: {},
        type: 'object',
      },
      summary: `SSE completion event for ${operation.name}.`,
      bindings: {
        http: {
          event: 'done',
        },
      },
      'x-weft-sse-frame': 'event: done\\n\\n',
    },
    [names.errorEvent]: {
      name: names.errorEvent,
      contentType: 'text/event-stream',
      payload: {
        properties: {
          code: { type: 'string' },
          data: {},
          message: { type: 'string' },
        },
        required: ['message'],
        type: 'object',
      },
      summary: `SSE error event for ${operation.name}.`,
      bindings: {
        http: {
          event: 'error',
        },
      },
      'x-weft-sse-frame': 'event: error\\ndata: <JSON Error>\\n\\n',
    },
  };
}

/**
 * Build an AsyncAPI operation entry for a stream or subscription operation.
 */
export function buildOperationEntry(
  operation: ErasedOperation,
  channelName: string,
  kind: 'subscription' | 'stream',
): Record<string, unknown> {
  const messageNames =
    kind === 'subscription'
      ? Object.values(webSocketMessageNames(operation))
      : Object.values(sseMessageNames(operation));

  return {
    action: 'receive',
    channel: { $ref: `#/channels/${jsonPointerEscape(channelName)}` },
    messages: messageNames.map((name) => ({ $ref: `#/components/messages/${name}` })),
    operationId: operation.name.replaceAll('.', '_'),
    summary: operation.summary,
    tags: [...operation.tags].toSorted().map((name) => ({ name })),
  };
}

function operationPrefix(operation: ErasedOperation): string {
  return operation.name.replaceAll('.', '_');
}

function subscriptionRequestMethod(operation: ErasedOperation): string {
  return operation.name === WORKFLOW_SUBSCRIPTION_OPERATION_NAME
    ? WORKFLOW_SUBSCRIPTION_REQUEST_METHOD
    : operation.name;
}

function webSocketMessageNames(operation: ErasedOperation): WebSocketMessageNames {
  const prefix = operationPrefix(operation);
  return {
    subscribeRequest: `${prefix}_subscribeRequest`,
    subscribeAck: `${prefix}_subscribeAck`,
    eventDeliver: `${prefix}_eventDeliver`,
    unsubscribeRequest: `${prefix}_unsubscribeRequest`,
    terminated: `${prefix}_terminated`,
    errorFrame: `${prefix}_errorFrame`,
  };
}

function sseMessageNames(operation: ErasedOperation): SseMessageNames {
  const prefix = operationPrefix(operation);
  return {
    tokenEvent: `${prefix}_tokenEvent`,
    doneEvent: `${prefix}_doneEvent`,
    errorEvent: `${prefix}_errorEvent`,
  };
}

function messageReferenceMap(
  names: WebSocketMessageNames | SseMessageNames,
): Record<string, unknown> {
  const references: Record<string, unknown> = {};
  for (const [key, name] of Object.entries(names).toSorted(([left], [right]) =>
    compareStrings(left, right),
  )) {
    references[key] = { $ref: `#/components/messages/${name}` };
  }
  return references;
}

function jsonRpcRequestPayload(method: string, paramsSchema: Record<string, unknown>): unknown {
  return {
    additionalProperties: false,
    properties: {
      id: JSON_RPC_ID_SCHEMA,
      jsonrpc: { const: JSON_RPC_VERSION, type: 'string' },
      method: { const: method, type: 'string' },
      params: paramsSchema,
    },
    required: ['jsonrpc', 'id', 'method', 'params'],
    type: 'object',
  };
}

function jsonRpcSuccessPayload(resultSchema: Record<string, unknown>): unknown {
  return {
    additionalProperties: false,
    properties: {
      id: JSON_RPC_ID_SCHEMA,
      jsonrpc: { const: JSON_RPC_VERSION, type: 'string' },
      result: resultSchema,
    },
    required: ['jsonrpc', 'id', 'result'],
    type: 'object',
  };
}

function eventDeliverPayload(eventSchema: Record<string, unknown>): unknown {
  return {
    additionalProperties: false,
    properties: {
      jsonrpc: { const: JSON_RPC_VERSION, type: 'string' },
      method: { const: EVENT_DELIVER_METHOD, type: 'string' },
      params: {
        additionalProperties: false,
        properties: {
          envelope: eventSchema,
          subscriptionId: { type: 'string' },
        },
        required: ['subscriptionId', 'envelope'],
        type: 'object',
      },
    },
    required: ['jsonrpc', 'method', 'params'],
    type: 'object',
  };
}

function terminatedPayload(): unknown {
  return {
    additionalProperties: false,
    properties: {
      jsonrpc: { const: JSON_RPC_VERSION, type: 'string' },
      method: { const: EVENTS_TERMINATED_METHOD, type: 'string' },
      params: {
        additionalProperties: false,
        properties: {
          fault: {
            type: 'object',
          },
          reason: SUBSCRIPTION_TERMINATION_REASON_SCHEMA,
          subscriptionId: { type: 'string' },
        },
        required: ['subscriptionId', 'reason'],
        type: 'object',
      },
    },
    required: ['jsonrpc', 'method', 'params'],
    type: 'object',
  };
}

function jsonRpcErrorPayload(): unknown {
  return {
    additionalProperties: false,
    properties: {
      error: { $ref: '#/components/schemas/JsonRpcError' },
      id: JSON_RPC_ID_SCHEMA,
      jsonrpc: { const: JSON_RPC_VERSION, type: 'string' },
    },
    required: ['jsonrpc', 'id', 'error'],
    type: 'object',
  };
}

function eventJsonSchema(
  operation: ErasedOperation,
  definitionSchemaToJsonSchema: (
    schema: z.ZodType,
    direction?: DefinitionSchemaDirection,
  ) => Record<string, unknown>,
): Record<string, unknown> {
  if (operation.eventSchema === undefined) return { type: 'object' };
  return definitionSchemaToJsonSchema(operation.eventSchema, 'output');
}

function jsonPointerEscape(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

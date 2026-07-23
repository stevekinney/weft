/**
 * JSON Schema declarations for the RemoteWorker WebSocket protocol contract.
 *
 * These schemas are the canonical wire-shape description for every protocol
 * message. They are re-exported from `@lostgradient/weft/worker-protocol` so the public
 * surface remains a single import path. The runtime parser guards in
 * `protocol.ts` mirror these schemas field-by-field; any drift here must be
 * reflected there as well.
 *
 * @module worker/protocol-schemas
 */

import { REMOTE_WORKER_PROTOCOL_VERSION } from './protocol-version.ts';

type JsonSchemaObject = {
  readonly [key: string]: unknown;
};

const jsonValueSchema: JsonSchemaObject = {
  $ref: '#/$defs/jsonValue',
};

const jsonObjectSchema: JsonSchemaObject = {
  type: 'object',
  additionalProperties: jsonValueSchema,
};

const stringMapSchema: JsonSchemaObject = {
  type: 'object',
  additionalProperties: { type: 'string' },
};

const protocolVersionSchema: JsonSchemaObject = {
  const: REMOTE_WORKER_PROTOCOL_VERSION,
};

/**
 * JSON Schema for every RemoteWorker protocol message, keyed by message type.
 *
 * @example
 * ```ts
 * import { REMOTE_WORKER_MESSAGE_SCHEMAS } from '@lostgradient/weft/worker-protocol';
 *
 * const registerSchema = REMOTE_WORKER_MESSAGE_SCHEMAS.register;
 * ```
 */
export const REMOTE_WORKER_MESSAGE_SCHEMAS = {
  register: {
    type: 'object',
    additionalProperties: false,
    required: ['type', 'protocolVersion', 'workerId', 'activities'],
    properties: {
      type: { const: 'register' },
      protocolVersion: protocolVersionSchema,
      workerId: { type: 'string', minLength: 1 },
      activities: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
      },
      concurrency: { type: 'number', minimum: 1, maximum: 1000 },
      queue: { type: 'string', minLength: 1 },
      deploymentName: { type: 'string', minLength: 1 },
      buildId: { type: 'string', minLength: 1 },
      runtimeVersion: { type: 'string', minLength: 1 },
      gitSha: { type: 'string', minLength: 1 },
      startedAt: { type: 'number' },
      capabilities: jsonObjectSchema,
    },
  },
  heartbeat: {
    type: 'object',
    additionalProperties: false,
    required: ['type', 'workerId'],
    properties: {
      type: { const: 'heartbeat' },
      workerId: { type: 'string', minLength: 1 },
    },
  },
  taskResult: {
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'operationId', 'status', 'value', 'attemptToken'],
        properties: {
          type: { const: 'taskResult' },
          operationId: { type: 'string', minLength: 1 },
          status: { const: 'completed' },
          value: jsonValueSchema,
          attemptToken: { type: 'string', minLength: 1 },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'operationId', 'status', 'error', 'attemptToken'],
        properties: {
          type: { const: 'taskResult' },
          operationId: { type: 'string', minLength: 1 },
          status: { const: 'failed' },
          error: { type: 'string' },
          attemptToken: { type: 'string', minLength: 1 },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'operationId', 'status', 'error', 'attemptToken'],
        properties: {
          type: { const: 'taskResult' },
          operationId: { type: 'string', minLength: 1 },
          status: { const: 'cancelled' },
          error: { type: 'string' },
          cancelled: { const: true },
          attemptToken: { type: 'string', minLength: 1 },
        },
      },
    ],
  },
  task: {
    type: 'object',
    additionalProperties: false,
    required: ['type', 'operationId', 'activityName', 'input', 'attemptToken'],
    properties: {
      type: { const: 'task' },
      operationId: { type: 'string', minLength: 1 },
      activityName: { type: 'string', minLength: 1 },
      input: jsonValueSchema,
      attempt: { type: 'number', minimum: 1 },
      headers: stringMapSchema,
      workflowExecutionToken: { type: 'string', minLength: 1 },
      attemptToken: { type: 'string', minLength: 1 },
    },
  },
  cancel: {
    type: 'object',
    additionalProperties: false,
    required: ['type', 'operationId'],
    properties: {
      type: { const: 'cancel' },
      operationId: { type: 'string', minLength: 1 },
    },
  },
  shutdown: {
    type: 'object',
    additionalProperties: false,
    required: ['type'],
    properties: {
      type: { const: 'shutdown' },
    },
  },
  registerAck: {
    type: 'object',
    additionalProperties: false,
    required: ['type', 'protocolVersion', 'workerId', 'queue', 'activities', 'concurrency'],
    properties: {
      type: { const: 'registerAck' },
      protocolVersion: protocolVersionSchema,
      workerId: { type: 'string', minLength: 1 },
      queue: { type: 'string', minLength: 1 },
      activities: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
      },
      concurrency: { type: 'number', minimum: 1, maximum: 1000 },
    },
  },
  registerError: {
    type: 'object',
    additionalProperties: false,
    required: ['type', 'code', 'message', 'supportedProtocolVersions'],
    properties: {
      type: { const: 'registerError' },
      code: { enum: ['invalid_registration', 'unsupported_protocol_version'] },
      message: { type: 'string' },
      supportedProtocolVersions: {
        type: 'array',
        items: protocolVersionSchema,
      },
      requestedProtocolVersion: { type: 'number' },
    },
  },
  protocolError: {
    type: 'object',
    additionalProperties: false,
    required: ['type', 'code', 'message'],
    properties: {
      type: { const: 'protocolError' },
      code: {
        enum: ['invalid_json', 'invalid_message', 'unknown_message_type', 'registration_required'],
      },
      message: { type: 'string' },
    },
  },
} as const satisfies Record<string, JsonSchemaObject>;

/**
 * Complete RemoteWorker protocol JSON Schema document.
 *
 * @example
 * ```ts
 * import { REMOTE_WORKER_PROTOCOL_JSON_SCHEMA } from '@lostgradient/weft/worker-protocol';
 *
 * const schemaId = REMOTE_WORKER_PROTOCOL_JSON_SCHEMA.$id;
 * ```
 */
export const REMOTE_WORKER_PROTOCOL_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://weft.dev/schemas/remote-worker-protocol.v1.json',
  title: 'Weft RemoteWorker Protocol v1',
  oneOf: Object.keys(REMOTE_WORKER_MESSAGE_SCHEMAS).map((messageType) => ({
    $ref: `#/$defs/messages/${messageType}`,
  })),
  $defs: {
    jsonValue: {
      oneOf: [
        { type: 'null' },
        { type: 'boolean' },
        { type: 'number' },
        { type: 'string' },
        { type: 'array', items: { $ref: '#/$defs/jsonValue' } },
        {
          type: 'object',
          additionalProperties: { $ref: '#/$defs/jsonValue' },
        },
      ],
    },
    jsonObject: jsonObjectSchema,
    messages: REMOTE_WORKER_MESSAGE_SCHEMAS,
  },
} as const satisfies JsonSchemaObject;

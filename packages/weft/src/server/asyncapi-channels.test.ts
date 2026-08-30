import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { DefinitionSchemaDirection } from '../core/types/definition-schema-to-json.ts';
import {
  buildOperationEntry,
  buildSseChannel,
  buildSseMessages,
  buildWebSocketChannel,
  buildWebSocketMessages,
} from './asyncapi-channels.ts';
import type { ErasedOperation } from './operation-catalog.ts';
import { createLiveOperationRegistry } from './rest-bindings.ts';

function definitionSchemaToJsonSchema(
  schema: z.ZodType,
  _direction?: DefinitionSchemaDirection,
): Record<string, unknown> {
  const result: unknown = z.toJSONSchema(schema, {
    unrepresentable: 'any',
  });
  if (isRecord(result) && '$schema' in result) {
    const { $schema: _unused, ...rest } = result;
    return rest;
  }
  return isRecord(result) ? result : {};
}

function operation(name: string): ErasedOperation {
  const found = createLiveOperationRegistry().get(name);
  if (found === undefined) {
    throw new Error(`expected operation ${name} to be registered`);
  }
  return found;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

describe('AsyncAPI channel builders', () => {
  it('buildWebSocketMessages returns all subscription message keys with operation prefixes', () => {
    const messages = buildWebSocketMessages(
      operation('weft.workflows.events'),
      definitionSchemaToJsonSchema,
    );

    expect(Object.keys(messages).toSorted()).toEqual([
      'weft_workflows_events_errorFrame',
      'weft_workflows_events_eventDeliver',
      'weft_workflows_events_subscribeAck',
      'weft_workflows_events_subscribeRequest',
      'weft_workflows_events_terminated',
      'weft_workflows_events_unsubscribeRequest',
    ]);
  });

  it('buildSseMessages returns all stream message keys with operation prefixes', () => {
    const messages = buildSseMessages(
      operation('weft.workflows.streams.sse'),
      definitionSchemaToJsonSchema,
    );

    expect(Object.keys(messages).toSorted()).toEqual([
      'weft_workflows_streams_sse_doneEvent',
      'weft_workflows_streams_sse_errorEvent',
      'weft_workflows_streams_sse_tokenEvent',
    ]);
  });

  it('buildSseMessages includes event envelopes and pings for live event streams', () => {
    const messages = buildSseMessages(
      operation('weft.workflows.events.sse'),
      definitionSchemaToJsonSchema,
    );

    expect(Object.keys(messages).toSorted()).toEqual([
      'weft_workflows_events_sse_errorEvent',
      'weft_workflows_events_sse_eventEnvelopeEvent',
      'weft_workflows_events_sse_pingEvent',
    ]);
    expect(messages['weft_workflows_events_sse_pingEvent']).toMatchObject({
      bindings: { http: { event: 'ping' } },
      'x-weft-sse-frame': 'event: ping\\ndata: {"emittedAtMs":<timestamp>}\\n\\n',
    });
  });

  it('omits empty bindings from SSE channels', () => {
    const channel = buildSseChannel(
      operation('weft.workflows.streams.sse'),
      '/v1/workflows/{id}/streams/sse',
    );

    expect(channel).not.toHaveProperty('bindings');
  });

  it('advertises the WebSocket channel address under the external /api prefix', () => {
    const channel = buildWebSocketChannel(operation('weft.workflows.events'));
    expect(channel['address']).toBe('/api/jsonrpc');
  });

  it('advertises SSE channel addresses under the external /api prefix', () => {
    const channel = buildSseChannel(
      operation('weft.workflows.streams.sse'),
      '/v1/workflows/{id}/streams/sse',
    );
    expect(channel['address']).toBe('/api/v1/workflows/{id}/streams/sse');
  });

  it('leaves the synthetic unbound SSE address unprefixed (not a wire endpoint)', () => {
    const channel = buildSseChannel(operation('weft.workflows.streams.sse'), undefined);
    expect(channel['address']).toBe('/x-weft-unbound/weft/workflows/streams/sse');
  });

  it('builds message payloads as JSON Schema objects', () => {
    const messages = {
      ...buildWebSocketMessages(operation('weft.workflows.events'), definitionSchemaToJsonSchema),
      ...buildSseMessages(operation('weft.workflows.streams.sse'), definitionSchemaToJsonSchema),
    };

    for (const message of Object.values(messages)) {
      const payload = message['payload'];
      expect(isRecord(payload)).toBe(true);
      if (isRecord(payload)) {
        expect('type' in payload || 'properties' in payload).toBe(true);
      }
    }
  });

  it('SSE token payload describes the wire (plain text), not the logical eventSchema', () => {
    // Bugbot regression: the token message previously claimed `data:`
    // carried a JSON encoding of `eventSchema` ({sequence, value}), but
    // `mapTokenChunkToText` emits the raw `token` string verbatim. The
    // logical schema is preserved as `x-weft-event-schema` for clients
    // that need it.
    const messages = buildSseMessages(
      operation('weft.workflows.streams.sse'),
      definitionSchemaToJsonSchema,
    );
    const token = messages['weft_workflows_streams_sse_tokenEvent'] as {
      payload: Record<string, unknown>;
      'x-weft-event-schema': Record<string, unknown>;
      'x-weft-sse-frame': string;
    };
    expect(token).toBeDefined();
    expect(token.payload).toEqual({ type: 'string' });
    expect(token['x-weft-sse-frame']).toContain('data: <token-text>');
    // Logical schema preserved, but as an extension — not the wire payload.
    expect(token['x-weft-event-schema']).toBeDefined();
  });

  it('terminated message reason enum mirrors what json-rpc-websocket actually emits', () => {
    // Bugbot regression: the enum previously listed `engine-error` and
    // `overflow` as advertised reasons, but the WebSocket session only
    // emits `client-unsubscribed`, `server-closed`, and
    // `validation-failed` (the engine-error / overflow cases collapse
    // into `server-closed` with a `fault` payload). Discovery docs that
    // promise reasons clients will never observe break codegen.
    const messages = buildWebSocketMessages(
      operation('weft.workflows.events'),
      definitionSchemaToJsonSchema,
    );
    const terminated = messages['weft_workflows_events_terminated'] as
      | { payload: Record<string, unknown> }
      | undefined;
    expect(terminated).toBeDefined();
    const properties = terminated!.payload['properties'] as Record<string, unknown>;
    const params = properties['params'] as Record<string, unknown>;
    const paramsProperties = params['properties'] as Record<string, unknown>;
    const reason = paramsProperties['reason'] as { enum: ReadonlyArray<string> };
    expect([...reason.enum].toSorted()).toEqual([
      'client-unsubscribed',
      'server-closed',
      'validation-failed',
    ]);
  });

  it('uses output-direction conversion for websocket output and event schemas', () => {
    const subscription = operation('weft.workflows.events');
    const calls: Array<{ schema: z.ZodType; direction: DefinitionSchemaDirection }> = [];

    buildWebSocketMessages(subscription, (schema, direction = 'input') => {
      calls.push({ schema, direction });
      return { type: 'object' };
    });

    expect(calls).toContainEqual({ schema: subscription.inputSchema, direction: 'input' });
    expect(calls).toContainEqual({ schema: subscription.outputSchema, direction: 'output' });
    expect(calls).toContainEqual({ schema: subscription.eventSchema!, direction: 'output' });
  });

  it('uses output-direction conversion for SSE event schemas', () => {
    const stream = operation('weft.workflows.streams.sse');
    const calls: Array<{ schema: z.ZodType; direction: DefinitionSchemaDirection }> = [];

    buildSseMessages(stream, (schema, direction = 'input') => {
      calls.push({ schema, direction });
      return { type: 'object' };
    });

    expect(calls).toContainEqual({ schema: stream.eventSchema!, direction: 'output' });
  });

  it('buildOperationEntry returns a channel reference and action', () => {
    const entry = buildOperationEntry(
      operation('weft.workflows.events'),
      'weft/workflows/events',
      'subscription',
    );

    expect(entry['action']).toBe('receive');
    expect(entry['channel']).toEqual({ $ref: '#/channels/weft~1workflows~1events' });
  });
});

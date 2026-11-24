import { z } from 'zod';

import type { ParameterizedAccessHint } from "../../embedded/backchannel/src/internals.ts";
import type { FleetEventEnvelope, FleetEventGapEnvelope } from '../fleet-event-feed.ts';
import type { EventEnvelope } from '../workflow-event-feed.ts';

const committedFleetEventEnvelopeSchema = z.object({
  kind: z.string(),
  workflowId: z.string().optional(),
  sequence: z.number(),
  cursor: z.string(),
  emittedAtMs: z.number(),
  payload: z.unknown(),
});

const fleetEventGapEnvelopeSchema: z.ZodType<FleetEventGapEnvelope> = z.object({
  kind: z.literal('fleet:gap'),
  sequence: z.number(),
  cursor: z.string(),
  emittedAtMs: z.number(),
  payload: z.object({
    requestedCursor: z.string(),
    firstRetainedSequence: z.number(),
  }),
});

export const fleetEventEnvelopeSchema: z.ZodType<FleetEventEnvelope> = z.union([
  committedFleetEventEnvelopeSchema,
  fleetEventGapEnvelopeSchema,
]);

export const workflowEventEnvelopeSchema: z.ZodType<EventEnvelope> = z.object({
  kind: z.string(),
  workflowId: z.string(),
  selector: z.enum(['events', 'tokens']),
  sequence: z.number(),
  cursor: z.string(),
  emittedAtMs: z.number(),
  payload: z.unknown(),
});

export const workflowEventParameterizedAccess: ParameterizedAccessHint = {
  discriminator: 'selector',
  defaultValue: 'events',
  variants: [
    {
      value: 'events',
      access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['events:read'] } },
    },
    {
      value: 'tokens',
      access: { kind: 'scoped', scopes: { kind: 'anyOf', scopes: ['streams:read'] } },
    },
  ],
};

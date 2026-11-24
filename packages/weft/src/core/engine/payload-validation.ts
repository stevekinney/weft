/**
 * The runtime half of `EngineOptions.payloadValidation`: running a declared
 * Standard Schema against an inbound payload before the engine accepts it.
 * The registration-time half (every inbound schema must carry a runtime
 * validator) lives in `schema-policy.ts`.
 *
 * Validation never transforms: the schema's output is discarded and the
 * caller's value is what the engine stores and delivers. A transform could
 * produce a value the serializer cannot round-trip, and the stored payload
 * must be the one the contract's JSON Schema describes.
 *
 * @module core/engine/payload-validation
 */

import { KEYS } from '../../storage/keys.ts';
import type { DefinitionSchema } from '../types.ts';
import { validateStandardSchema } from '../types/standard-schema-validate.ts';
import { getResolvedDynamicRegistration } from './dynamic-source-execution.ts';
import type { RegistrationEntry } from './engine-internal-types.ts';
import type { EngineInternals } from './internals.ts';
import { decodeWorkflowState } from './validation.ts';

/** An inbound boundary, with the field and operation names its wire request uses. */
const BOUNDARIES = {
  start: { fieldName: 'input', operation: 'weft.workflows.start' },
  signal: { fieldName: 'payload', operation: 'weft.workflows.signal' },
  update: { fieldName: 'payload', operation: 'weft.workflows.update' },
  query: { fieldName: 'input', operation: 'weft.workflows.query' },
} as const;

type InboundBoundary = keyof typeof BOUNDARIES;

/**
 * Throw `StandardSchemaValidationError` when the engine validates inbound
 * payloads and `payload` fails `schema`. A no-op when validation is off or no
 * schema is declared.
 */
export async function validateInboundPayload(
  internals: EngineInternals,
  boundary: InboundBoundary,
  schema: DefinitionSchema | undefined,
  payload: unknown,
): Promise<void> {
  if (internals.options.payloadValidation !== 'inbound' || schema === undefined) return;
  await validateStandardSchema(schema, payload, BOUNDARIES[boundary]);
}

/**
 * The registration a running workflow executes, for looking up its declared
 * message schemas: the live identity this engine holds, else the stored
 * state's type and revision. `undefined` for an unknown workflow, or a
 * dynamic-source type this process has not loaded.
 */
async function resolveWorkflowRegistration(
  internals: EngineInternals,
  workflowId: string,
): Promise<RegistrationEntry | undefined> {
  let identity: { type: string; revision?: string | undefined } | undefined =
    internals.workflowTypeByWorkflowId.get(workflowId);
  if (identity === undefined) {
    const stateBytes = await internals.storage.get(KEYS.workflow(workflowId));
    if (stateBytes === null) return undefined;
    identity = decodeWorkflowState(stateBytes);
  }
  return getResolvedDynamicRegistration(internals, identity.type, identity.revision);
}

/**
 * Validate signals bound for the stored workflow `targetState` (absent when
 * the workflow does not exist yet) against its declared signal schemas.
 */
export async function validateSignalsForWorkflow(
  internals: EngineInternals,
  targetState: { readonly type: string; readonly revision?: string | undefined } | null | undefined,
  deliveries: ReadonlyArray<{ readonly signalName: string; readonly payload: unknown }>,
): Promise<void> {
  if (internals.options.payloadValidation !== 'inbound' || targetState == null) return;
  await validateSignalPayloads(
    internals,
    getResolvedDynamicRegistration(internals, targetState.type, targetState.revision),
    deliveries,
  );
}

/**
 * Validate an update's or query's input against the declared message's
 * `inputSchema` on the workflow `workflowId` runs.
 */
export async function validateMessageInput(
  internals: EngineInternals,
  boundary: 'update' | 'query',
  workflowId: string,
  name: string,
  payload: unknown,
): Promise<void> {
  if (internals.options.payloadValidation !== 'inbound') return;
  const registration = await resolveWorkflowRegistration(internals, workflowId);
  const messages = boundary === 'update' ? registration?.updates : registration?.queries;
  const schema = declaredMessage(registration, messages, boundary, name)?.inputSchema;
  await validateInboundPayload(internals, boundary, schema, payload);
}

/**
 * Validate each signal payload against the declared signal's `inputSchema`
 * on `registration`, the workflow the signals target.
 */
export async function validateSignalPayloads(
  internals: EngineInternals,
  registration: RegistrationEntry | undefined,
  deliveries: ReadonlyArray<{ readonly signalName: string; readonly payload: unknown }>,
): Promise<void> {
  for (const { signalName, payload } of deliveries) {
    const declared = declaredMessage(registration, registration?.signals, 'signal', signalName);
    await validateInboundPayload(internals, 'signal', declared?.inputSchema, payload);
  }
}

/**
 * The declared definition a message `name` arrives under: the one whose wire
 * name it is, else the one a builder key aliases it to. A closed message set
 * admits both, so both must reach the declared schema.
 */
function declaredMessage<TMessage>(
  registration: RegistrationEntry | undefined,
  messages: Readonly<Record<string, TMessage>> | undefined,
  kind: 'signal' | 'update' | 'query',
  name: string,
): TMessage | undefined {
  if (messages === undefined) return undefined;
  if (Object.hasOwn(messages, name)) return messages[name];
  const aliases = registration?.messageAliases?.[kind];
  const wireName =
    aliases !== undefined && Object.hasOwn(aliases, name) ? aliases[name] : undefined;
  return wireName === undefined || !Object.hasOwn(messages, wireName)
    ? undefined
    : messages[wireName];
}

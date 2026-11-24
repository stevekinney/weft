/**
 * Registration-time normalization of a builder workflow's declarations: its
 * signal, update, and query maps, re-keyed by each message's wire name, the
 * builder keys that alias a different wire name, and its `.uses()` map.
 *
 * @module core/engine/builder-declarations
 */

import type {
  ActivityDefinition,
  QueryDefinition,
  SignalDefinition,
  UpdateDefinition,
  WorkflowDefinition,
} from '../types.ts';
import type { MessageAliases, RegistrationEntry } from './engine-internal-types.ts';
import { normalizeUsedActivities } from './used-activities.ts';

type RuntimeNamedMessageDefinition = {
  readonly name: string;
};

type BuilderDeclarations = WorkflowDefinition & {
  readonly activities: Readonly<Record<string, Readonly<ActivityDefinition>>>;
  readonly signals: Readonly<Record<string, Readonly<SignalDefinition<unknown>>>>;
  readonly updates: Readonly<Record<string, Readonly<UpdateDefinition<unknown>>>>;
  readonly queries: Readonly<Record<string, Readonly<QueryDefinition<unknown>>>>;
};

function normalizeMessageDefinitions<TDefinition extends RuntimeNamedMessageDefinition>(
  workflowType: string,
  messageKind: 'signal' | 'update' | 'query',
  definitions: Readonly<Record<string, TDefinition>>,
): Readonly<Record<string, TDefinition>> {
  const normalized = Object.create(null) as Record<string, TDefinition>;
  const sortedDefinitions = Object.values(definitions).toSorted((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  for (const definition of sortedDefinitions) {
    if (Object.hasOwn(normalized, definition.name)) {
      throw new Error(
        `Duplicate ${messageKind} runtime name "${definition.name}" in workflow "${workflowType}"`,
      );
    }
    normalized[definition.name] = definition;
  }
  return normalized;
}

/** Builder keys whose definition carries a different wire name, mapped to that wire name. */
function aliasesOf(
  definitions: Readonly<Record<string, RuntimeNamedMessageDefinition>>,
): Readonly<Record<string, string>> | undefined {
  const aliases = Object.create(null) as Record<string, string>;
  for (const [key, definition] of Object.entries(definitions)) {
    if (key !== definition.name) aliases[key] = definition.name;
  }
  return Object.keys(aliases).length === 0 ? undefined : aliases;
}

function collectMessageAliases(registration: BuilderDeclarations): MessageAliases | undefined {
  const aliases: { -readonly [K in keyof MessageAliases]: MessageAliases[K] } = {};
  const signal = aliasesOf(registration.signals);
  if (signal !== undefined) aliases.signal = signal;
  const update = aliasesOf(registration.updates);
  if (update !== undefined) aliases.update = update;
  const query = aliasesOf(registration.queries);
  if (query !== undefined) aliases.query = query;
  return Object.keys(aliases).length === 0 ? undefined : aliases;
}

/** Store a builder definition's normalized declarations on `entry`. */
export function applyBuilderDeclarations(
  entry: RegistrationEntry,
  workflowType: string,
  registration: BuilderDeclarations,
): void {
  entry.signals = normalizeMessageDefinitions(workflowType, 'signal', registration.signals);
  entry.updates = normalizeMessageDefinitions(workflowType, 'update', registration.updates);
  entry.queries = normalizeMessageDefinitions(workflowType, 'query', registration.queries);
  const messageAliases = collectMessageAliases(registration);
  if (messageAliases !== undefined) entry.messageAliases = messageAliases;
  const uses = normalizeUsedActivities(workflowType, registration);
  if (uses !== undefined) entry.uses = uses;
}

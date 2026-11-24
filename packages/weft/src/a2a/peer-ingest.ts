/**
 * The one boundary every peer-derived value crosses before the client retains or emits it.
 * A peer's tasks, status updates, messages, artifact updates, and Agent Card reach the client
 * through several paths (the first response, stream events, `GetTask` polls, resubscription,
 * cancel recovery, the card read); each path calls the function here for its payload kind, so
 * the bounds on string length, part count, artifact count, and content size are applied in
 * exactly one place. `peer-ingest.test.ts` fails when a path stops using it.
 *
 * @module a2a/peer-ingest
 */

import type { AgentCard, Artifact, Message, Task } from '@a2a-js/sdk';

import type { A2APeerArtifact, A2APeerTaskState } from './peer-client-types.ts';
import { A2APeerError } from './peer-client-types.ts';
import { foldArtifactUpdate, mapArtifact, peerStateOf, textOfMessage } from './peer-parts.ts';

export { DEFAULT_PEER_ARTIFACT_LIMIT } from './peer-parts.ts';

/** The most artifacts one task keeps. */
export const MAX_PEER_ARTIFACTS = 256;

/** The longest task, context, or message identifier accepted. */
export const MAX_PEER_IDENTIFIER_LENGTH = 1024;

/** The longest Agent Card name, version, or description kept. */
export const MAX_PEER_CARD_TEXT_LENGTH = 4096;

/** The most interfaces and extensions an Agent Card may list. */
export const MAX_PEER_CARD_ENTRIES = 64;

/** A task's status after bounding: what the tracker needs and nothing more. */
export interface IngestedStatus {
  readonly state: A2APeerTaskState;
  /** Identifies the status for change detection: state, timestamp, and message id. */
  readonly stamp: string;
  /** The status message's text, bounded; undefined when the status carries no message. */
  readonly text: string | undefined;
}

/** A task after bounding. */
export interface IngestedTask {
  readonly taskId: string;
  readonly contextId: string;
  readonly status: IngestedStatus;
  readonly artifacts: A2APeerArtifact[];
}

function boundedIdentifier(value: string, what: string): string {
  if (value.length > MAX_PEER_IDENTIFIER_LENGTH) {
    throw new A2APeerError(
      'protocol',
      `The peer sent a ${what} longer than ${MAX_PEER_IDENTIFIER_LENGTH} characters.`,
    );
  }
  return value;
}

/** Bounds a task or artifact-update identifier pair. */
export function ingestIdentity(
  taskId: string,
  contextId: string,
): { taskId: string; contextId: string } {
  return {
    taskId: boundedIdentifier(taskId, 'task id'),
    contextId: boundedIdentifier(contextId, 'context id'),
  };
}

/**
 * Refuses an identity that differs from the one this peer task already has. An empty identifier
 * says nothing (a status update may leave the context unstated) and never differs; a task or
 * context that changes between responses is a peer that has mixed up two tasks, and following on
 * would attribute the second one's state and content to the first.
 */
export function assertSameIdentity(
  known: { readonly taskId: string; readonly contextId: string },
  next: { readonly taskId: string; readonly contextId: string },
): void {
  for (const [what, held, seen] of [
    ['task', known.taskId, next.taskId],
    ['context', known.contextId, next.contextId],
  ] as const) {
    if (held !== '' && seen !== '' && held !== seen) {
      throw new A2APeerError(
        'protocol',
        `The peer changed the ${what} identifier of a task it already named.`,
      );
    }
  }
}

/** What a peer task's identity is once `next` is read against `known`: unstated parts keep the known value. */
export function mergeIdentity(
  known: { readonly taskId: string; readonly contextId: string },
  next: { readonly taskId: string; readonly contextId: string },
): { taskId: string; contextId: string } {
  return {
    taskId: next.taskId === '' ? known.taskId : next.taskId,
    contextId: next.contextId === '' ? known.contextId : next.contextId,
  };
}

/** Bounds a message's text to `limit` characters. */
export function ingestMessageText(message: Message | undefined, limit: number): string {
  return textOfMessage(message).slice(0, limit);
}

/** Bounds a task status; its message text is cut to `limit` characters. */
export function ingestStatus(status: Task['status'], limit: number): IngestedStatus {
  const state = peerStateOf(status?.state);
  const messageId = boundedIdentifier(status?.message?.messageId ?? '', 'message id');
  const timestamp = (status?.timestamp ?? '').slice(0, MAX_PEER_IDENTIFIER_LENGTH);
  return {
    state,
    stamp: `${state}|${timestamp}|${messageId}`,
    text: status?.message === undefined ? undefined : ingestMessageText(status.message, limit),
  };
}

/** Bounds a whole task: identity, status, and at most {@link MAX_PEER_ARTIFACTS} artifacts. */
export function ingestTask(task: Task, limit: number): IngestedTask {
  return {
    ...ingestIdentity(task.id, task.contextId),
    status: ingestStatus(task.status, limit),
    artifacts: task.artifacts
      .slice(0, MAX_PEER_ARTIFACTS)
      .map((artifact) => mapArtifact(artifact, limit)),
  };
}

/**
 * Folds one artifact update into the artifacts already kept, never keeping more than
 * {@link MAX_PEER_ARTIFACTS} artifacts, `limit` characters, or the part cap per artifact.
 */
export function ingestArtifactUpdate(
  kept: readonly A2APeerArtifact[],
  update: Artifact,
  append: boolean,
  limit: number,
): A2APeerArtifact[] {
  return foldArtifactUpdate(kept, update, append, limit, MAX_PEER_ARTIFACTS);
}

function boundedText(value: string): string {
  return value.slice(0, MAX_PEER_CARD_TEXT_LENGTH);
}

/** Bounds an Agent Card's retained strings and refuses one with an absurd number of entries. */
export function ingestCard(card: AgentCard): AgentCard {
  const extensions = card.capabilities?.extensions ?? [];
  if (
    card.supportedInterfaces.length > MAX_PEER_CARD_ENTRIES ||
    extensions.length > MAX_PEER_CARD_ENTRIES
  ) {
    throw new A2APeerError(
      'card-unavailable',
      `The Agent Card lists more than ${MAX_PEER_CARD_ENTRIES} interfaces or extensions.`,
    );
  }
  return {
    ...card,
    name: boundedText(card.name),
    version: boundedText(card.version),
    description: boundedText(card.description),
  };
}

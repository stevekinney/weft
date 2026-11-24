/**
 * Maps a peer's tasks, messages, and artifacts to the plain shapes the peer client returns.
 * Everything here treats the peer's content as untrusted: a `url` part is kept as a reference
 * and never fetched, `raw` bytes are never carried, and oversized content is dropped.
 *
 * @module a2a/peer-parts
 */

import { type Artifact, type Message, type Part, TaskState } from '@a2a-js/sdk';

import type { A2APeerArtifact, A2APeerPart, A2APeerTaskState } from './peer-client-types.ts';
import { A2APeerError } from './peer-client-types.ts';

/** The largest artifact content, in UTF-16 code units, the client keeps per artifact. */
export const DEFAULT_PEER_ARTIFACT_LIMIT = 1_048_576;

const STATE_NAMES: ReadonlyMap<TaskState, A2APeerTaskState> = new Map([
  [TaskState.TASK_STATE_SUBMITTED, 'submitted'],
  [TaskState.TASK_STATE_WORKING, 'working'],
  [TaskState.TASK_STATE_INPUT_REQUIRED, 'input-required'],
  [TaskState.TASK_STATE_AUTH_REQUIRED, 'auth-required'],
  [TaskState.TASK_STATE_COMPLETED, 'completed'],
  [TaskState.TASK_STATE_FAILED, 'failed'],
  [TaskState.TASK_STATE_CANCELED, 'canceled'],
  [TaskState.TASK_STATE_REJECTED, 'rejected'],
]);

/** The client's name for a wire `TaskState`; an unspecified or unknown state reads as `working`. */
export function peerStateOf(state: TaskState | undefined): A2APeerTaskState {
  return (state === undefined ? undefined : STATE_NAMES.get(state)) ?? 'working';
}

/** Whether `state` means the task will not progress without a new message from the caller. */
export function isStopState(state: A2APeerTaskState): boolean {
  return state !== 'submitted' && state !== 'working';
}

/** The text parts of `message` joined by a newline; empty when it has none. */
export function textOfMessage(message: Message | undefined): string {
  if (message === undefined) return '';
  const texts: string[] = [];
  for (const part of message.parts) {
    if (part.content?.$case === 'text') texts.push(part.content.value);
  }
  return texts.join('\n');
}

function sizeOf(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** The longest artifact identifier accepted. */
const MAX_ARTIFACT_ID_LENGTH = 1024;

/** The most parts one artifact keeps, whatever their size. */
export const MAX_PEER_ARTIFACT_PARTS = 256;

function omitted(
  mediaType: string,
  filename: string,
  reason: 'too-large' | 'binary',
  remaining: number,
): { part: A2APeerPart; size: number } {
  // The placeholder keeps the peer's strings only while they fit the budget.
  const size = mediaType.length + filename.length;
  return size > remaining
    ? { part: { kind: 'omitted', mediaType: '', filename: '', reason }, size: 0 }
    : { part: { kind: 'omitted', mediaType, filename, reason }, size };
}

/**
 * Maps one wire part. Returns the mapped part and the size it counts against the artifact's
 * budget: every string the part retains counts.
 */
function mapPart(part: Part, remaining: number): { part: A2APeerPart; size: number } {
  const mediaType = part.mediaType;
  const filename = part.filename;
  const content = part.content;
  if (content === undefined) return { part: { kind: 'text', text: '' }, size: 0 };
  switch (content.$case) {
    case 'text':
      return content.value.length > remaining
        ? omitted(mediaType, filename, 'too-large', remaining)
        : { part: { kind: 'text', text: content.value }, size: content.value.length };
    case 'data': {
      const size = sizeOf(content.value);
      return size > remaining
        ? omitted(mediaType, filename, 'too-large', remaining)
        : { part: { kind: 'data', data: content.value }, size };
    }
    case 'url': {
      const size = content.value.length + mediaType.length + filename.length;
      return size > remaining
        ? omitted(mediaType, filename, 'too-large', remaining)
        : { part: { kind: 'reference', url: content.value, mediaType, filename }, size };
    }
    default:
      return omitted(mediaType, filename, 'binary', remaining);
  }
}

function partSize(part: A2APeerPart): number {
  switch (part.kind) {
    case 'text':
      return part.text.length;
    case 'data':
      return sizeOf(part.data);
    case 'reference':
      return part.url.length + part.mediaType.length + part.filename.length;
    default:
      return part.mediaType.length + part.filename.length;
  }
}

function headerSize(artifact: { artifactId: string; name: string; description: string }): number {
  return artifact.artifactId.length + artifact.name.length + artifact.description.length;
}

/** What a mapped artifact has spent of its budget: its header strings and every part. */
function artifactSize(artifact: A2APeerArtifact): number {
  return artifact.parts.reduce((total, part) => total + partSize(part), headerSize(artifact));
}

/**
 * Maps a wire artifact, spending at most `limit - used` characters across its parts and keeping
 * at most {@link MAX_PEER_ARTIFACT_PARTS} parts including the `existingParts` already kept.
 * Header strings are charged unless the update appends to an artifact that already paid them.
 */
export function mapArtifact(
  artifact: Artifact,
  limit: number,
  used = 0,
  existingParts = 0,
  chargeHeader = true,
): A2APeerArtifact {
  if (artifact.artifactId.length > MAX_ARTIFACT_ID_LENGTH) {
    throw new A2APeerError(
      'protocol',
      `The peer sent an artifact id longer than ${MAX_ARTIFACT_ID_LENGTH} characters.`,
    );
  }
  let remaining = Math.max(0, limit - used);
  // The header strings are retained, so they spend the budget first; a long name is cut.
  let name = artifact.name;
  let description = artifact.description;
  if (chargeHeader) {
    remaining = Math.max(0, remaining - artifact.artifactId.length);
    name = name.slice(0, remaining);
    remaining -= name.length;
    description = description.slice(0, remaining);
    remaining -= description.length;
  }
  const room = Math.max(0, MAX_PEER_ARTIFACT_PARTS - existingParts);
  const parts: A2APeerPart[] = [];
  for (const part of artifact.parts.slice(0, room)) {
    const mapped = mapPart(part, remaining);
    remaining -= mapped.size;
    parts.push(mapped.part);
  }
  return { artifactId: artifact.artifactId, name, description, parts };
}

/**
 * Folds an artifact update into the mapped `artifacts`, mapping it first so the content kept
 * never exceeds `limit` per artifact however many chunks the peer sends: `append` adds to the
 * artifact with the same identifier, and otherwise the update replaces (or adds) it.
 */
export function foldArtifactUpdate(
  artifacts: readonly A2APeerArtifact[],
  update: Artifact,
  append: boolean,
  limit: number,
  maxArtifacts: number,
): A2APeerArtifact[] {
  const index = artifacts.findIndex((entry) => entry.artifactId === update.artifactId);
  const existing = index === -1 ? undefined : artifacts[index];
  if (existing === undefined) {
    if (artifacts.length >= maxArtifacts) return [...artifacts];
    return [...artifacts, mapArtifact(update, limit)];
  }
  const next = [...artifacts];
  next[index] = append
    ? {
        ...existing,
        parts: [
          ...existing.parts,
          ...mapArtifact(update, limit, artifactSize(existing), existing.parts.length, false).parts,
        ],
      }
    : mapArtifact(update, limit);
  return next;
}

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';

import { TaskState, type Artifact, type StreamResponse, type Task } from '@a2a-js/sdk';

import { A2APeerError, type A2APeerOutcome } from './peer-client-types.ts';
import {
  ingestCard,
  MAX_PEER_ARTIFACTS,
  MAX_PEER_CARD_ENTRIES,
  MAX_PEER_IDENTIFIER_LENGTH,
} from './peer-ingest.ts';
import { MAX_PEER_ARTIFACT_PARTS } from './peer-parts.ts';
import { PeerTaskTracker } from './peer-task-tracker.ts';

const LIMIT = 1_000;

type Part = Artifact['parts'][number];

function part(content: NonNullable<Part['content']>, mediaType = '', filename = ''): Part {
  return { content, metadata: undefined, filename, mediaType };
}

function artifact(parts: Part[], artifactId = 'a', name = ''): Artifact {
  return { artifactId, name, description: '', parts, metadata: undefined, extensions: [] };
}

function message(text: string, messageId = 'm') {
  return {
    messageId,
    contextId: 'c',
    taskId: 't',
    role: 2,
    parts: [part({ $case: 'text', value: text })],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  } as never;
}

function task(artifacts: Artifact[], text = '', id = 't'): Task {
  return {
    id,
    contextId: 'c',
    status: {
      state: TaskState.TASK_STATE_WORKING,
      message: text === '' ? undefined : message(text),
      timestamp: undefined,
    },
    artifacts,
    history: [],
    metadata: undefined,
  };
}

/** Every way a peer's task content reaches the tracker, as the wire path that carries it. */
const ENTRY_PATHS: ReadonlyArray<{
  name: string;
  feed: (tracker: PeerTaskTracker, artifacts: Artifact[], text: string, id: string) => void;
}> = [
  {
    name: 'first response, GetTask, CancelTask (applyTask)',
    feed: (tracker, artifacts, text, id) => tracker.applyTask(task(artifacts, text, id)),
  },
  {
    name: 'stream or resubscribe task snapshot',
    feed: (tracker, artifacts, text, id) =>
      tracker.apply({
        payload: { $case: 'task', value: task(artifacts, text, id) },
      }),
  },
  {
    name: 'stream status update',
    feed: (tracker, artifacts, text, id) => {
      tracker.apply({
        payload: {
          $case: 'statusUpdate',
          value: {
            taskId: id,
            contextId: 'c',
            status: task([], text, id).status,
            metadata: undefined,
          },
        },
      });
      for (const entry of artifacts) feedArtifact(tracker, entry, false);
    },
  },
  {
    name: 'stream artifact update (replace)',
    feed: (tracker, artifacts, text, id) => {
      tracker.applyTask(task([], text, id));
      for (const entry of artifacts) feedArtifact(tracker, entry, false);
    },
  },
  {
    name: 'stream artifact update (append, repeated)',
    feed: (tracker, artifacts, text, id) => {
      tracker.applyTask(task([], text, id));
      for (const entry of artifacts) {
        feedArtifact(tracker, entry, true);
        feedArtifact(tracker, entry, true);
      }
    },
  },
];

function feedArtifact(tracker: PeerTaskTracker, entry: Artifact, append: boolean): void {
  tracker.apply({
    payload: {
      $case: 'artifactUpdate',
      value: { taskId: 't', contextId: 'c', artifact: entry, append, lastChunk: false },
    },
  } as StreamResponse);
}

function newTracker(): PeerTaskTracker {
  return new PeerTaskTracker(
    { agentName: 'p', agentVersion: '1', cardUrl: 'u' },
    { text: '' },
    LIMIT,
    false,
  );
}

function retainedSize(outcome: A2APeerOutcome): number {
  let total = outcome.message.length;
  for (const entry of outcome.artifacts) {
    total += entry.artifactId.length + entry.name.length + entry.description.length;
    for (const kept of entry.parts) {
      if (kept.kind === 'text') total += kept.text.length;
      else if (kept.kind === 'data') total += JSON.stringify(kept.data).length;
      else if (kept.kind === 'reference')
        total += kept.url.length + kept.mediaType.length + kept.filename.length;
      else total += kept.mediaType.length + kept.filename.length;
    }
  }
  return total;
}

const HOSTILE: ReadonlyArray<{ name: string; artifacts: () => Artifact[] }> = [
  {
    name: 'a huge parts array of references',
    artifacts: () => [
      artifact(
        Array.from({ length: MAX_PEER_ARTIFACT_PARTS * 4 }, () =>
          part({ $case: 'url', value: 'https://x.test/a' }),
        ),
      ),
    ],
  },
  {
    name: 'a huge parts array of empty parts',
    artifacts: () => [
      artifact(Array.from({ length: MAX_PEER_ARTIFACT_PARTS * 4 }, () => ({}) as Part)),
    ],
  },
  {
    name: 'oversized reference, media type, and filename strings',
    artifacts: () => [
      artifact(
        [
          part(
            { $case: 'url', value: `https://x.test/${'a'.repeat(50_000)}` },
            'm'.repeat(50_000),
            'f'.repeat(50_000),
          ),
          part({ $case: 'raw', value: Buffer.alloc(1) }, 'm'.repeat(50_000), 'f'.repeat(50_000)),
        ],
        'id',
        'n'.repeat(50_000),
      ),
    ],
  },
  {
    name: 'more artifacts than a task keeps',
    artifacts: () =>
      Array.from({ length: MAX_PEER_ARTIFACTS + 100 }, (_, index) =>
        artifact([part({ $case: 'text', value: 'x' })], `artifact-${index}`),
      ),
  },
  {
    name: 'text far over the artifact limit',
    artifacts: () => [artifact([part({ $case: 'text', value: 'x'.repeat(100_000) })])],
  },
];

describe('the peer ingestion boundary', () => {
  for (const path of ENTRY_PATHS) {
    describe(path.name, () => {
      for (const hostile of HOSTILE) {
        test(`bounds ${hostile.name}`, () => {
          const tracker = newTracker();
          path.feed(tracker, hostile.artifacts(), '', 't');
          const outcome = tracker.outcome();
          expect(outcome.artifacts.length).toBeLessThanOrEqual(MAX_PEER_ARTIFACTS);
          for (const entry of outcome.artifacts) {
            expect(entry.parts.length).toBeLessThanOrEqual(MAX_PEER_ARTIFACT_PARTS);
            const own = retainedSize({ ...outcome, message: '', artifacts: [entry] });
            // The limit bounds what an artifact spends; blanked placeholders add nothing.
            expect(own).toBeLessThanOrEqual(LIMIT);
          }
        });
      }

      test('bounds a status message to the limit', () => {
        const tracker = newTracker();
        path.feed(tracker, [], 'z'.repeat(100_000), 't');
        expect(tracker.outcome().message.length).toBeLessThanOrEqual(LIMIT);
      });

      test('refuses an oversized task identifier', () => {
        const tracker = newTracker();
        const id = 'i'.repeat(MAX_PEER_IDENTIFIER_LENGTH + 1);
        try {
          path.feed(tracker, [], '', id);
        } catch (error) {
          expect(error).toBeInstanceOf(A2APeerError);
          return;
        }
        // The artifact-only paths carry the identifier on the task they open with.
        expect(tracker.taskId().length).toBeLessThanOrEqual(MAX_PEER_IDENTIFIER_LENGTH);
      });
    });
  }

  test('bounds a bare message the same way', () => {
    const tracker = newTracker();
    tracker.apply({
      payload: { $case: 'message', value: message('z'.repeat(100_000)) },
    });
    expect(tracker.outcome().message.length).toBeLessThanOrEqual(LIMIT);
  });

  test('bounds the Agent Card', () => {
    const card = {
      name: 'n'.repeat(100_000),
      version: 'v'.repeat(100_000),
      description: 'd'.repeat(100_000),
      supportedInterfaces: [],
      capabilities: undefined,
    } as never;
    const bounded = ingestCard(card);
    expect(bounded.name.length).toBeLessThan(10_000);
    const crowded = {
      ...(card as object),
      supportedInterfaces: Array.from({ length: MAX_PEER_CARD_ENTRIES + 1 }, () => ({})),
    } as never;
    expect(() => ingestCard(crowded)).toThrow(A2APeerError);
  });
});

/** Every wire path that carries a task or context identifier, feeding it a changed one. */
const IDENTITY_PATHS: ReadonlyArray<{
  name: string;
  feed: (tracker: PeerTaskTracker, taskId: string, contextId: string) => void;
}> = [
  {
    name: 'a task snapshot (first response, GetTask, resubscribe)',
    feed: (tracker, taskId, contextId) =>
      tracker.apply({
        payload: { $case: 'task', value: { ...task([], '', taskId), contextId } },
      }),
  },
  {
    name: 'CancelTask or a GetTask poll (applyTask)',
    feed: (tracker, taskId, contextId) => tracker.applyTask({ ...task([], '', taskId), contextId }),
  },
  {
    name: 'a stream status update',
    feed: (tracker, taskId, contextId) =>
      tracker.apply({
        payload: {
          $case: 'statusUpdate',
          value: { taskId, contextId, status: task([], '', taskId).status, metadata: undefined },
        },
      }),
  },
  {
    name: 'a stream artifact update',
    feed: (tracker, taskId, contextId) =>
      tracker.apply({
        payload: {
          $case: 'artifactUpdate',
          value: {
            taskId,
            contextId,
            artifact: artifact([part({ $case: 'text', value: 'x' })]),
            append: false,
            lastChunk: false,
            metadata: undefined,
          },
        },
      }),
  },
  {
    name: 'a bare message',
    feed: (tracker, taskId, contextId) =>
      tracker.apply({
        payload: { $case: 'message', value: { ...(message('hi') as object), taskId, contextId } },
      } as never),
  },
];

describe('a peer task keeps the identity the peer first gave it', () => {
  for (const path of IDENTITY_PATHS) {
    describe(path.name, () => {
      test('refuses a different task identifier', () => {
        const tracker = newTracker();
        tracker.applyTask(task([], '', 't'));

        expect(() => path.feed(tracker, 'another-task', 'c')).toThrow(A2APeerError);
        expect(tracker.taskId()).toBe('t');
      });

      test('refuses a different context identifier', () => {
        const tracker = newTracker();
        tracker.applyTask(task([], '', 't'));

        expect(() => path.feed(tracker, 't', 'another-context')).toThrow(A2APeerError);
        expect(tracker.contextId()).toBe('c');
      });

      test('accepts the same identity, and an identifier left unstated', () => {
        const tracker = newTracker();
        tracker.applyTask(task([], '', 't'));

        path.feed(tracker, 't', 'c');
        path.feed(tracker, 't', '');
        path.feed(tracker, '', 'c');

        expect(tracker.taskId()).toBe('t');
      });
    });
  }

  test('refuses a first response that names another task than the continuation addressed', () => {
    const tracker = new PeerTaskTracker(
      { agentName: 'p', agentVersion: '1', cardUrl: 'u' },
      { text: '', taskId: 'addressed' },
      LIMIT,
      true,
    );

    expect(() => tracker.applyTask(task([], '', 'someone-else'))).toThrow(A2APeerError);
  });
});

describe('the ingestion boundary is the only way in', () => {
  const sources = readdirSync(import.meta.dir)
    .filter((name) => name.startsWith('peer-') && name.endsWith('.ts') && !name.includes('.test'))
    .filter((name) => name !== 'peer-ingest.ts' && name !== 'peer-parts.ts');

  test('only peer-ingest maps or folds peer content', () => {
    for (const name of sources) {
      const source = readFileSync(`${import.meta.dir}/${name}`, 'utf8');
      expect(source, name).not.toMatch(/\b(mapArtifact|foldArtifactUpdate|textOfMessage)\b/);
    }
  });

  test('the tracker reads peer content only through peer-ingest', () => {
    const source = readFileSync(`${import.meta.dir}/peer-task-tracker.ts`, 'utf8');
    expect(source).not.toMatch(/\b(task|update|message|value)\.(artifacts|history|parts)\b/);
    expect(source).not.toMatch(/status\??\.(message|timestamp)/);
  });
});

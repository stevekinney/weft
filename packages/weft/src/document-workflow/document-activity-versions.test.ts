/**
 * A document pins the version of each activity handler it uses. The pin is part of the document's
 * version, so the same steps pinned to another version are another revision; a host that does not
 * have the pinned version refuses the document; and a run parked on a pinned revision resumes on
 * exactly the handler it was pinned to.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../embedded/storage/src/index.ts";
import { waitForCondition } from "../../test-support/embedded/testing/src/fake-timers.ts";

import { Engine } from '../core/engine/index.ts';
import {
  validateWorkflowDocument,
  WorkflowDocumentValidationError,
  workflowDocumentVersion,
  type DocumentWorkflowHost,
} from './document.ts';
import { registerWorkflowDocuments } from './register.ts';

/** A host whose `x__y` handler answers `tag` and is at `version`. */
function hostAt(version: string | undefined, tag = `v${version ?? 'none'}`): DocumentWorkflowHost {
  return {
    activities: { x__y: () => tag, plain: () => 'plain' },
    triggerKinds: { manual: () => undefined },
    ...(version === undefined ? {} : { activityVersions: { x__y: version } }),
  };
}

function document(activityVersions?: Record<string, string>): Record<string, unknown> {
  return {
    name: 'pinned',
    trigger: { kind: 'manual' },
    steps: [
      { kind: 'await-signal', signal: 'go' },
      { kind: 'activity', handler: 'x__y' },
    ],
    ...(activityVersions === undefined ? {} : { activityVersions }),
  };
}

function issuesOf(input: unknown, host: DocumentWorkflowHost) {
  try {
    validateWorkflowDocument(input, host);
  } catch (error) {
    if (error instanceof WorkflowDocumentValidationError) return error.issues;
    throw error;
  }
  return [];
}

describe('a document that pins activity versions', () => {
  it('has a different version from the same steps pinned to another version, or to none', async () => {
    const unpinned = await workflowDocumentVersion(
      validateWorkflowDocument(document(), hostAt('1')),
    );
    const one = await workflowDocumentVersion(
      validateWorkflowDocument(document({ x__y: '1' }), hostAt('1')),
    );
    const two = await workflowDocumentVersion(
      validateWorkflowDocument(document({ x__y: '2' }), hostAt('2')),
    );
    expect(new Set([unpinned, one, two]).size).toBe(3);
  });

  it('validates when the host has the handler at the pinned version', () => {
    expect(issuesOf(document({ x__y: '1' }), hostAt('1'))).toEqual([]);
  });

  it('is refused when the host has the handler at another version', () => {
    expect(issuesOf(document({ x__y: '1' }), hostAt('2'))).toEqual([
      {
        path: 'activityVersions.x__y',
        message: 'activity handler "x__y" is pinned at version "1", but this host has version "2"',
      },
    ]);
  });

  it('is refused when the host gives the handler no version', () => {
    expect(issuesOf(document({ x__y: '1' }), hostAt(undefined))).toEqual([
      {
        path: 'activityVersions.x__y',
        message:
          'activity handler "x__y" is pinned at version "1", but this host has no version of it',
      },
    ]);
  });

  it('validates a pin for a handler used inside a branch', () => {
    const nested = {
      ...document({ x__y: '1' }),
      steps: [
        {
          kind: 'branch',
          on: 'status',
          cases: { ready: [{ kind: 'activity', handler: 'x__y' }] },
        },
      ],
    };
    expect(issuesOf(nested, hostAt('1'))).toEqual([]);
    expect(issuesOf(nested, hostAt('2'))).toEqual([
      {
        path: 'activityVersions.x__y',
        message: 'activity handler "x__y" is pinned at version "1", but this host has version "2"',
      },
    ]);
  });

  it('validates a pin for a handler used inside a map', () => {
    const nested = {
      ...document({ x__y: '1' }),
      steps: [
        {
          kind: 'map',
          over: 'items',
          steps: [{ kind: 'activity', handler: 'x__y' }],
        },
      ],
    };
    expect(issuesOf(nested, hostAt('1'))).toEqual([]);
    expect(issuesOf(nested, hostAt('2'))).toEqual([
      {
        path: 'activityVersions.x__y',
        message: 'activity handler "x__y" is pinned at version "1", but this host has version "2"',
      },
    ]);
  });

  it('is refused when it pins a handler no step uses', () => {
    expect(issuesOf(document({ plain: '1' }), hostAt('1')).map((issue) => issue.path)).toEqual([
      'activityVersions.plain',
    ]);
  });

  it('does not take an inherited handler name for a version the host has', () => {
    const issues = issuesOf(
      { ...document({ constructor: '1' }), steps: [{ kind: 'activity', handler: 'x__y' }] },
      hostAt('1'),
    );
    expect(issues.map((issue) => issue.path)).toContain('activityVersions.constructor');
  });

  it('is refused when a pin is not a non-empty string', () => {
    expect(issuesOf(document({ x__y: '' }), hostAt('1')).length).toBeGreaterThan(0);
    expect(
      issuesOf({ ...document(), activityVersions: { x__y: 1 } }, hostAt('1')).length,
    ).toBeGreaterThan(0);
  });
});

describe('a run parked on a revision that pins an activity', () => {
  /** Park `pinned-run` on a revision pinned at `version`, then return its storage. */
  async function parkedAt(version: string): Promise<MemoryStorage> {
    const storage = new MemoryStorage();
    await using original = new Engine({ storage });
    await registerWorkflowDocuments(original, hostAt(version), {
      active: [document({ x__y: version })],
    });
    await original.start('pinned', null, { id: 'pinned-run' });
    await waitForCondition(
      async () => {
        const timeline = await original.getTimeline('pinned-run');
        return timeline.some((entry) => entry.operationType === 'wait-signal');
      },
      { label: 'pinned-run parked on its signal' },
    );
    return storage;
  }

  it('resumes on the handler it was pinned to when that version is loaded again', async () => {
    const storage = await parkedAt('1');
    await using restarted = new Engine({ storage });
    await registerWorkflowDocuments(restarted, hostAt('1'), { active: [document({ x__y: '1' })] });
    const [handle] = await restarted.recoverAll();
    await handle!.signal('go', null);
    expect(await handle!.result()).toBe('v1');
  });

  it('cannot register the pinned revision under a host that has only another version', async () => {
    const storage = await parkedAt('1');
    await using restarted = new Engine({ storage });
    let thrown: unknown;
    try {
      await registerWorkflowDocuments(restarted, hostAt('2'), {
        active: [document({ x__y: '2' })],
        retained: [document({ x__y: '1' })],
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WorkflowDocumentValidationError);
  });

  it('registers the other version as a separate revision of the same workflow', async () => {
    const storage = new MemoryStorage();
    await using engine = new Engine({ storage });
    const [one] = await registerWorkflowDocuments(engine, hostAt('1'), {
      active: [document({ x__y: '1' })],
    });
    const [two] = await registerWorkflowDocuments(engine, hostAt('2'), {
      active: [document({ x__y: '2' })],
    });
    expect(one!.workflowVersion).not.toBe(two!.workflowVersion);
    expect(one!.revision).not.toBe(two!.revision);
  });
});

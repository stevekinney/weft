import { describe, expect, test } from 'bun:test';

import { HttpClientError } from '@lostgradient/weft/client';

import {
  classifyRevisionAgainstActive,
  EAGER_REVISION_HEDGE,
  fetchActiveWorkflowRevision,
  FRESH_START_REVISION_HEDGE,
  isWorkflowCatalogActivePointerLike,
  type WorkflowActiveRevisionClient,
  type WorkflowCatalogActivePointerLike,
} from './workflow-revision.ts';

const POINTER: WorkflowCatalogActivePointerLike = {
  revision: 'order-processing-rev-a',
  generation: 3,
  activatedAt: 1_700_000_000_000,
};

describe('isWorkflowCatalogActivePointerLike', () => {
  test('accepts a well-formed pointer', () => {
    expect(isWorkflowCatalogActivePointerLike(POINTER)).toBe(true);
  });

  test('rejects non-objects and missing/mistyped fields', () => {
    expect(isWorkflowCatalogActivePointerLike(null)).toBe(false);
    expect(isWorkflowCatalogActivePointerLike(undefined)).toBe(false);
    expect(isWorkflowCatalogActivePointerLike('nope')).toBe(false);
    expect(isWorkflowCatalogActivePointerLike({ revision: 'r', generation: 1 })).toBe(false);
    expect(isWorkflowCatalogActivePointerLike({ revision: 1, generation: 1, activatedAt: 1 })).toBe(
      false,
    );
  });
});

describe('classifyRevisionAgainstActive', () => {
  test('unpinned: revision is undefined, regardless of active', () => {
    expect(classifyRevisionAgainstActive(undefined, POINTER)).toBe('unpinned');
    expect(classifyRevisionAgainstActive(undefined, null)).toBe('unpinned');
    expect(classifyRevisionAgainstActive(undefined, undefined)).toBe('unpinned');
  });

  test('unknown: active is null or undefined (never-activated/denied/loading)', () => {
    expect(classifyRevisionAgainstActive('rev-a', null)).toBe('unknown');
    expect(classifyRevisionAgainstActive('rev-a', undefined)).toBe('unknown');
  });

  test('active: revision equals the active pointer revision', () => {
    expect(classifyRevisionAgainstActive(POINTER.revision, POINTER)).toBe('active');
  });

  test('stale: revision differs from the active pointer revision', () => {
    expect(classifyRevisionAgainstActive('order-processing-rev-old', POINTER)).toBe('stale');
  });
});

function clientReturning(value: unknown): WorkflowActiveRevisionClient {
  return {
    operations: {
      'weft.workflows.active.get': () => Promise.resolve(value),
    },
  };
}

describe('fetchActiveWorkflowRevision', () => {
  test('resolves the pointer for a well-formed response', async () => {
    await expect(
      fetchActiveWorkflowRevision(clientReturning(POINTER), 'order-processing'),
    ).resolves.toEqual(POINTER);
  });

  test('resolves null for "never activated" (NotFound fault)', async () => {
    const client: WorkflowActiveRevisionClient = {
      operations: {
        'weft.workflows.active.get': () =>
          Promise.reject(new HttpClientError(404, 'not found', { faultCode: 'NotFound' })),
      },
    };
    await expect(fetchActiveWorkflowRevision(client, 'never-activated')).resolves.toBeNull();
  });

  test('throws an HttpClientError (Unprocessable) for a malformed non-null body', async () => {
    const client = clientReturning({ revision: 'rev-a' }); // missing generation/activatedAt
    await expect(fetchActiveWorkflowRevision(client, 'order-processing')).rejects.toThrow(
      HttpClientError,
    );
    try {
      await fetchActiveWorkflowRevision(client, 'order-processing');
      throw new Error('expected a throw');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpClientError);
      expect((error as HttpClientError).faultCode).toBe('Unprocessable');
    }
  });

  test('rethrows any other fault (not NotFound)', async () => {
    const client: WorkflowActiveRevisionClient = {
      operations: {
        'weft.workflows.active.get': () =>
          Promise.reject(new HttpClientError(403, 'forbidden', { faultCode: 'Forbidden' })),
      },
    };
    await expect(fetchActiveWorkflowRevision(client, 'order-processing')).rejects.toThrow(
      HttpClientError,
    );
  });
});

describe('EAGER_REVISION_HEDGE', () => {
  test('is a non-empty, apostrophe-straight sentence', () => {
    expect(EAGER_REVISION_HEDGE.length).toBeGreaterThan(0);
    expect(EAGER_REVISION_HEDGE).not.toContain('’');
  });
});

describe('FRESH_START_REVISION_HEDGE', () => {
  test('is a non-empty, apostrophe-straight sentence, distinct from EAGER_REVISION_HEDGE', () => {
    expect(FRESH_START_REVISION_HEDGE.length).toBeGreaterThan(0);
    expect(FRESH_START_REVISION_HEDGE).not.toContain('’');
    // Hedges a different claim (a fresh start's "whichever is currently
    // active" vs. a default fork/recovery's "retains the source
    // revision") — must not collapse into one shared string that blurs
    // the two mechanisms.
    expect(FRESH_START_REVISION_HEDGE).not.toBe(EAGER_REVISION_HEDGE);
  });
});

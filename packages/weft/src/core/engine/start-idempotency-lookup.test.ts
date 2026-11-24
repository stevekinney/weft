/**
 * COR-1951 — `engine.getByIdempotencyKey`: a read-only lookup of the run a keyed start created, for
 * a caller that cannot tell whether its start committed.
 */
import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { rejectionOf } from "../../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { describe, expect, it } from 'bun:test';

import { Engine } from '../engine.ts';
import { StartWorkflowValidationError } from '../start-workflow-validation.ts';
import { workflow } from '../types.ts';
import { IdempotencyKeyPurgedError } from './errors.ts';

const completesImmediately = workflow({ name: 'completes-immediately' }).execute(
  async function* () {
    return 'done';
  },
);

function createEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  engine.register(completesImmediately);
  return engine;
}

describe('engine.getByIdempotencyKey', () => {
  it('answers null for a key no start has used, and starts nothing', async () => {
    const engine = createEngine();
    try {
      expect(await engine.getByIdempotencyKey('never-used')).toBeNull();
      const listed = await engine.list();
      expect(listed.total).toBe(0);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('answers the run a keyed start created, finished or not, and does not start another', async () => {
    const engine = createEngine();
    try {
      const handle = await engine.start('completes-immediately', null, { idempotencyKey: 'k-1' });
      await handle.result();

      const found = await engine.getByIdempotencyKey('k-1');

      expect(found).toMatchObject({ id: handle.id, type: 'completes-immediately' });
      expect(found?.versionTuple.workflowVersion).toBeString();
      const listed = await engine.list();
      expect(listed.total).toBe(1);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('throws IdempotencyKeyPurgedError when the run was purged, as a start with that key does', async () => {
    const engine = createEngine();
    try {
      const handle = await engine.start('completes-immediately', null, { idempotencyKey: 'k-2' });
      await handle.result();
      await engine.purge({ idPrefix: handle.id });

      expect(await rejectionOf(engine.getByIdempotencyKey('k-2'))).toBeInstanceOf(
        IdempotencyKeyPurgedError,
      );
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('refuses a key a start would refuse', async () => {
    const engine = createEngine();
    try {
      expect(await rejectionOf(engine.getByIdempotencyKey('k'.repeat(118)))).toBeInstanceOf(
        StartWorkflowValidationError,
      );
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });
});

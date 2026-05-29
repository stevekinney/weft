/**
 * Pins the `destructive` classification for every cataloged operation.
 *
 * `destructive` is the single source of truth read by the CLI `weft api`
 * confirmation gate, dashboard bulk-action confirmations, and MCP exposure.
 * Two failure modes must stay impossible:
 *
 *   1. A new operation ships without an explicit `destructive` value. The
 *      type system forces the declaration; the registry guard backstops
 *      hand-rolled literals. This suite proves the guard rejects a missing
 *      flag and proves the live registry is exhaustively classified — a new
 *      operation that nobody classified here fails the exhaustiveness check.
 *   2. A known-destructive operation is silently marked non-destructive (or
 *      vice versa). The expected map below pins each operation's value.
 */

import { describe, expect, it } from 'bun:test';

import { z } from 'zod';
import type { RegistrableOperation } from '../operation-catalog.ts';
import { createOperationRegistry } from '../operation-catalog.ts';
import { defineOperation } from '../operation-registry.ts';
import { createLiveOperationRegistry } from '../rest-bindings.ts';

/**
 * The authoritative expected classification. Every operation in the live
 * registry must appear here, and its `destructive` flag must match. Update
 * this map (with deliberate review) when adding or reclassifying an
 * operation — that is the point of the exhaustiveness assertion below.
 */
const EXPECTED_DESTRUCTIVE: Readonly<Record<string, boolean>> = {
  // Irreversible / hard-to-undo mutations.
  'weft.workflows.cancel': true,
  'weft.workflows.timeout': true,
  'weft.workflows.purge': true,
  'weft.workflows.signal': true,
  'weft.workflows.update': true,
  'weft.recover.all': true,
  'weft.schedules.cancel': true,
  'weft.reviews.decision.submit': true,
  'weft.workflows.bulk.cancel': true,
  'weft.workflows.bulk.delete': true,
  'weft.workflows.bulk.signal': true,
  'weft.workflows.bulk.tags': true,
  'weft.workers.drain': true,
  'weft.worker.deployments.drain': true,
  'weft.storage.put': true,
  'weft.storage.delete': true,
  'weft.storage.batch': true,
  'weft.storage.conditionalbatch': true,

  // Reads, additive starts, and reversible control-plane operations.
  'weft.workflows.start': false,
  'weft.workflows.fork': false,
  'weft.workflows.resume': false,
  'weft.workflows.replay': false,
  'weft.workflows.get': false,
  'weft.workflows.result.get': false,
  'weft.workflows.attributes.get': false,
  'weft.workflows.attributes.set': false,
  'weft.workflows.events.list': false,
  'weft.workflows.timeline.get': false,
  'weft.workflows.query': false,
  'weft.workflows.list': false,
  'weft.workflows.aggregate': false,
  'weft.workflows.tags.add': false,
  'weft.workflows.tags.remove': false,
  'weft.workflows.checkpoints.get': false,
  'weft.workflows.checkpoints.list': false,
  'weft.workflows.streams.chunks': false,
  'weft.workflows.streams.sse': false,
  'weft.workflows.events': false,
  'weft.updates.result.get': false,
  'weft.retention.get': false,
  'weft.reviews.get': false,
  'weft.reviews.list': false,
  'weft.schedules.create': false,
  'weft.schedules.update': false,
  'weft.schedules.get': false,
  'weft.schedules.list': false,
  'weft.schedules.pause': false,
  'weft.schedules.resume': false,
  'weft.system.registry': false,
  'weft.system.metrics': false,
  'weft.tasks.diagnostics': false,
  'weft.workers.list': false,
  'weft.workers.resume': false,
  'weft.worker.deployments.resume': false,
  'weft.task.queues.list': false,
  'weft.storage.get': false,
  'weft.storage.scan': false,
};

describe('operation destructive classification', () => {
  it('classifies every live operation exhaustively and correctly', () => {
    // A single whole-map comparison covers all three failure modes at once:
    // a new operation missing from the expected map, a stale expected entry
    // no longer in the registry, and any operation whose flag drifts from the
    // pinned value. (Every value in EXPECTED_DESTRUCTIVE is a boolean, so the
    // comparison also proves each live flag is a boolean.) On failure, Bun's
    // object diff names the exact offending operation and its values.
    const actual: Record<string, boolean> = {};
    for (const operation of createLiveOperationRegistry().list()) {
      actual[operation.name] = operation.destructive;
    }
    expect(actual).toEqual({ ...EXPECTED_DESTRUCTIVE });
  });
});

describe('registry destructive completeness guard', () => {
  // A fully valid operation built through the typed builder. Tests below
  // mutate a shallow copy to simulate hand-rolled literals or third-party
  // adapters that bypass `defineOperation` — those copies are deliberately
  // invalid runtime shapes, so they travel through `unknown` rather than
  // pretending to satisfy `RegistrableOperation`.
  function validOperation(): RegistrableOperation {
    return defineOperation({
      name: 'weft.test.guardfixture',
      summary: 'fixture',
      mcpExposable: false,
      destructive: false,
      inputSchema: z.object({ field: z.string() }),
      outputSchema: z.object({}),
      access: { kind: 'public' },
      transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: true, jsonRpcStdio: true },
      unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
      invoke: async () => ({}),
    });
  }

  it('rejects an operation that omits the destructive flag', () => {
    const { destructive: _omitted, ...withoutDestructive } = validOperation();
    expect(() =>
      createOperationRegistry([withoutDestructive as unknown as RegistrableOperation]),
    ).toThrow(/must declare an explicit boolean "destructive" flag/);
  });

  it('rejects a non-boolean destructive flag', () => {
    const operation = { ...validOperation(), destructive: 'yes' };
    expect(() => createOperationRegistry([operation as unknown as RegistrableOperation])).toThrow(
      /must declare an explicit boolean "destructive" flag/,
    );
  });

  it('accepts an operation that declares destructive explicitly', () => {
    expect(() => createOperationRegistry([validOperation()])).not.toThrow();
  });
});

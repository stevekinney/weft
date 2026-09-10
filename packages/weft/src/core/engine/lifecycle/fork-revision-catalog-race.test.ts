/**
 * WFT-21, Codex review round 1, P1: fork's own commit fenced against a
 * concurrent `removeWorkflowRevision()` targeting the fork's persisted
 * revision.
 *
 * An explicit-revision fork ({@link ForkOptions.revision}) onto a revision
 * OTHER than the source run's own pin performs only a process-local
 * availability check ({@link assertForkRevisionResolvable}) — unlike a
 * fresh `engine.start()`, it reserves no `inFlightStartsByRevision` entry,
 * so nothing durable protects the target revision between that check and
 * the fork's own commit. Before this fix, `fork()`'s `commitFencedEngineWrite`
 * call carried NO base conditions at all: a `removeWorkflowRevision()` racing
 * concurrently against the SAME target revision could observe zero
 * references (the fork hasn't committed yet, so nothing pins the revision),
 * delete the catalog entry, and the fork's own commit — landing right
 * behind it — would still durably persist a running `WorkflowState` pinned
 * to a revision the catalog now claims is gone.
 *
 * `buildForkCatalogEntryCondition()` (`fork-helpers.ts`) closes this by
 * reusing `start()`'s own `buildCatalogEntryRevisionCondition` fence: under
 * any ownership mode besides `'none'`, the fork's commit now conditions on
 * the target revision's catalog-entry bytes still matching what the fork
 * itself observed — so whichever operation lands second loses its CAS. This
 * test proves the fix end to end: park the fork's own commit exactly there,
 * let `removeWorkflowRevision()` complete underneath it, then prove the
 * fork's own commit fails closed (not a silent, durably orphaned write).
 *
 * The lost-race error itself was, until round 4, a generic `Error` — Codex
 * review round 4, P2 flagged that `resolveForkAccess()` (`server/operations/
 * fork-workflow.ts`) only maps a typed `WorkflowRevisionUnavailableError` to
 * a `Conflict` fault, so this specific loss (unlike the identical class the
 * PRE-commit check in `buildForkCatalogEntryCondition()` already throws
 * typed) surfaced as a masked `EngineFailure`/500 instead of `Conflict`/409.
 * `buildForkCommitLostRaceError()` now throws the same typed error for this
 * commit-time loss too — this test's assertion below covers that fix.
 */
import { describe, expect, it } from 'bun:test';

import { KEYS } from '../../../storage/interface.ts';
import { MemoryStorage } from '../../../storage/memory.ts';
import { ActivityRegistry } from '../../activity-registry.ts';
import { decode, encode } from '../../codec.ts';
import { Engine } from '../../engine.ts';
import { buildWorkflowManifestFromDefinition } from '../../registry-workflow-manifest.ts';
import { workflowSource } from '../../source/index.ts';
import { workflow, type WorkflowContext, type WorkflowDefinition } from '../../types.ts';
import { copyWorkflowDefinition } from '../construction.ts';
import { getWorkflowCatalog, removeWorkflowRevision } from '../index.ts';
import { getInternals } from '../internals.ts';
import { buildRegistrationEntry } from '../registration.ts';
import { WorkflowRevisionUnavailableError } from '../revision-errors.ts';
import { buildForkCommitLostRaceError } from './fork-helpers.ts';

async function revisionFor(name: string, definition: WorkflowDefinition): Promise<string> {
  const entry = buildRegistrationEntry(name, definition);
  const registered = copyWorkflowDefinition(name, entry);
  const manifest = await buildWorkflowManifestFromDefinition(
    registered,
    new ActivityRegistry().listDefinitions(),
  );
  return manifest.revision;
}

describe('fork() vs. a concurrent removeWorkflowRevision() — WFT-21 Codex review P1', () => {
  it("fails the fork's own commit closed when its target revision is removed underneath it, rather than persisting an orphaned running state", async () => {
    const storage = new MemoryStorage();
    const type = 'fork-catalog-race';
    const definitionV1 = workflow({ name: type, description: 'v1' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      return yield* ctx.waitForSignal<string>('go');
    });
    const definitionV2 = workflow({ name: type, description: 'v2' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      return yield* ctx.waitForSignal<string>('go');
    });
    const revisionV1 = await revisionFor(type, definitionV1);
    const revisionV2 = await revisionFor(type, definitionV2);

    // A real, lease-holding engine — `buildForkCatalogEntryCondition` is a
    // no-op under the default `ownership: 'none'`, so this race needs a
    // mode where `ownershipMode !== 'none'` to be reachable at all.
    const engineA = await Engine.create({
      storage,
      ownership: 'lease',
      leaseRenewInterval: '1s',
      leaseTtl: '2s',
    });
    try {
      engineA.registerSource(
        workflowSource(
          { name: type, location: './v1.ts', exportName: 'v1', revision: revisionV1 },
          async () => ({ v1: definitionV1 }),
        ),
      );
      // The source run pins to v1 and stays non-terminal (parked on
      // `waitForSignal`) — a durable reference to v1, never to v2.
      const sourceHandle = await engineA.start(type, null, { id: 'fork-catalog-race-source' });

      // Register AND resolve v2 as a second candidate — resolving installs
      // it into the durable catalog (a real `catalog-entry:` record) without
      // activating it, so it stays unreferenced and removable.
      engineA.registerSource(
        workflowSource(
          { name: type, location: './v2.ts', exportName: 'v2', revision: revisionV2 },
          async () => ({ v2: definitionV2 }),
        ),
      );
      await engineA.resolveWorkflowSource(type, revisionV2);
      expect(await getWorkflowCatalog(engineA).hasInstalled(type, revisionV2)).toBe(true);

      // `removeWorkflowRevision()` itself commits unfenced (no lease/claim
      // needed for its own writes), so a plain, unleased engine sharing the
      // SAME storage is a legitimate separate caller — mirrors
      // `catalog-removal.test.ts`'s own separate-process pattern.
      const engineB = new Engine({ storage });
      try {
        const gate = Promise.withResolvers<void>();
        const entered = Promise.withResolvers<void>();
        const originalConditionalBatch = storage.conditionalBatch.bind(storage);
        let paused = false;
        storage.conditionalBatch = async (conditions, operations) => {
          if (!paused) {
            paused = true;
            entered.resolve();
            await gate.promise;
          }
          return originalConditionalBatch(conditions, operations);
        };

        // Park the fork's own commit exactly at its `conditionalBatch` call
        // — its catalog-entry condition already captured v2's current bytes
        // (read before this gated call) before pausing here.
        const forkPromise = engineA.fork(sourceHandle.id, { revision: revisionV2 });
        await entered.promise;

        // Restore the real `conditionalBatch` for engine B's own removal so
        // it is not itself gated by the same wrapper.
        storage.conditionalBatch = originalConditionalBatch;
        const removed = await removeWorkflowRevision(engineB, type, revisionV2);
        expect(removed).toEqual({ removed: true });
        expect(await getWorkflowCatalog(engineB).hasInstalled(type, revisionV2)).toBe(false);

        // Release the fork's parked commit — its own catalog-entry
        // condition now points at bytes the delete above already
        // invalidated, so the whole batch loses its CAS.
        gate.resolve();
        let forkError: unknown;
        try {
          await forkPromise;
        } catch (error) {
          forkError = error;
        }
        // Typed, not a generic `Error` (WFT-21, Codex review round 4, P2) —
        // so `resolveForkAccess()` maps this to a `Conflict` fault instead
        // of a masked `EngineFailure`.
        expect(forkError).toBeInstanceOf(WorkflowRevisionUnavailableError);
        expect((forkError as WorkflowRevisionUnavailableError).reason).toBe('not-installed');
        expect((forkError as WorkflowRevisionUnavailableError).workflowType).toBe(type);
        expect((forkError as WorkflowRevisionUnavailableError).revision).toBe(revisionV2);

        // No orphaned reference: the source's own run is the only `wf:`
        // record for this type, and none of them are pinned to the
        // now-removed v2.
        const runs = await engineA.list({ type });
        expect(runs.items).toHaveLength(1);
        expect(runs.items[0]?.id).toBe(sourceHandle.id);
        expect(runs.items[0]?.revision).toBe(revisionV1);
        expect(await storage.get(KEYS.catalogEntry(type, revisionV2))).toBeNull();

        await engineA.signal(sourceHandle.id, 'go', 'done');
        await expect(sourceHandle.result()).resolves.toBe('done');
      } finally {
        engineB[Symbol.dispose]();
      }
    } finally {
      await engineA.shutdown();
    }
  });
});

/**
 * WFT-21, Codex review round 3, P1: a SEPARATE gap the round-2 fix (the
 * `inFlightStartsByRevision` reservation above, protecting `ownership:
 * 'none'`) did not close — a legacy (pre-revision-pinning) source run on a
 * dynamic-source type with exactly one registered candidate.
 *
 * `resolveForkTargetRevision()` reserves against `targetRevision`
 * (`options.revision ?? sourceState.revision`) as early as possible. For
 * this legacy case, `sourceState.revision` is genuinely `undefined` (no
 * `options.revision` either, for a default fork), so `targetRevision` is
 * `undefined` and the early reservation is a no-op — yet the resolver
 * BELOW still resolves the sole candidate's real revision, and the fork
 * still persists against it (`persistedRevision`, via
 * `resolveForkPersistedRevision()`'s own fallback chain). Under `ownership:
 * 'none'`, with nothing reserved, a concurrent `removeWorkflowRevision()`
 * on the SAME engine instance could see zero references for that real
 * revision and succeed in removing it, while the fork is still mid-flight
 * toward persisting a run pinned to it.
 *
 * `fork()` now reserves a SECOND slot for `persistedRevision` once it
 * differs from `targetRevision` — exactly this legacy case — closing the
 * gap. This test proves it directly: park the fork's own plain
 * `storage.batch()` write (the `ownership: 'none'` fast path, no
 * conditions), and prove the reservation is already visible to
 * `removeWorkflowRevision()` on the SAME engine at that point.
 */
describe('fork() legacy-dynamic-source default fork — WFT-21 Codex review round 3 P1', () => {
  it("reserves the resolver's own resolved revision even when the source run predates revision pinning", async () => {
    const storage = new MemoryStorage();
    const type = 'fork-legacy-inflight';
    const definitionV1 = workflow({ name: type, description: 'v1' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      return yield* ctx.waitForSignal<string>('go');
    });
    const revisionV1 = await revisionFor(type, definitionV1);

    // Default `ownership: 'none'` — the mode `buildForkCatalogEntryCondition`
    // deliberately skips, so only the in-flight reservation protects this
    // race here.
    const engine = new Engine({ storage });
    try {
      engine.registerSource(
        workflowSource(
          { name: type, location: './v1.ts', exportName: 'v1', revision: revisionV1 },
          async () => ({ v1: definitionV1 }),
        ),
      );
      const sourceHandle = await engine.start(type, null, { id: 'fork-legacy-source' });

      // Simulate a legacy (pre-revision-pinning) record by stripping the
      // persisted `revision` field directly in storage.
      const stateBytes = await storage.get(KEYS.workflow(sourceHandle.id));
      const legacyState = { ...(decode(stateBytes!) as Record<string, unknown>) };
      delete legacyState['revision'];
      await storage.put(KEYS.workflow(sourceHandle.id), encode(legacyState));

      const originalBatch = storage.batch.bind(storage);
      const gate = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      let paused = false;
      storage.batch = async (operations) => {
        if (!paused) {
          paused = true;
          entered.resolve();
          await gate.promise;
        }
        return originalBatch(operations);
      };

      // Default fork — no `options.revision` — onto the legacy source's
      // sole registered candidate.
      const forkPromise = engine.fork(sourceHandle.id);
      await entered.promise;

      // Parked exactly at the fork's own commit: the resolver already ran
      // and reserved `revisionV1` (the sole candidate it resolved), even
      // though `targetRevision` itself was `undefined`.
      const refused = await removeWorkflowRevision(engine, type, revisionV1);
      expect(refused.removed).toBe(false);
      if (!refused.removed && refused.reason === 'referenced') {
        expect(refused.references.inFlightStarts).toBe(1);
      } else {
        throw new Error(`expected a "referenced" refusal, got ${JSON.stringify(refused)}`);
      }

      storage.batch = originalBatch;
      gate.resolve();
      const forked = await forkPromise;
      const forkedState = await engine.get(forked.id);
      expect(forkedState?.revision).toBe(revisionV1);

      // The reservation is released once the fork settles — the revision
      // is removable again purely on the reservation dimension (still
      // referenced by both runs' own `nonTerminalRuns`, which is fine —
      // this test is about `inFlightStarts` specifically).
      expect(getInternals(engine).inFlightStartsByRevision.size).toBe(0);

      await engine.signal(sourceHandle.id, 'go', 'done');
      await engine.signal(forked.id, 'go', 'done');
      await expect(sourceHandle.result()).resolves.toBe('done');
      await expect(forked.result()).resolves.toBe('done');
    } finally {
      engine[Symbol.dispose]();
    }
  });
});

describe('buildForkCommitLostRaceError — WFT-21 Codex review round 4 P2', () => {
  it('throws the typed WorkflowRevisionUnavailableError when the fork carried a non-empty catalog-entry condition', () => {
    const error = buildForkCommitLostRaceError('wf-1', 'checkout', 'sha256:target', [
      { key: 'catalog-entry:checkout:sha256:target', expectedValue: new Uint8Array([1]) },
    ]);
    expect(error).toBeInstanceOf(WorkflowRevisionUnavailableError);
    expect((error as WorkflowRevisionUnavailableError).reason).toBe('not-installed');
    expect((error as WorkflowRevisionUnavailableError).workflowType).toBe('checkout');
    expect((error as WorkflowRevisionUnavailableError).revision).toBe('sha256:target');
  });

  it("falls back to a generic error when the fork carried no catalog-entry condition — a defensive branch that never fires in production (see this function's own doc), never silently misclassifying an unexpected loss as a revision conflict", () => {
    const error = buildForkCommitLostRaceError('wf-1', 'checkout', undefined, []);
    expect(error).not.toBeInstanceOf(WorkflowRevisionUnavailableError);
    expect(error.message).toContain('lost its CAS race');
  });
});

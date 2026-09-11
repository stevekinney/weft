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
import { ForkSourceReplacedError } from '../errors.ts';
import { getWorkflowCatalog, removeWorkflowRevision } from '../index.ts';
import { getInternals } from '../internals.ts';
import { buildRegistrationEntry } from '../registration.ts';
import { WorkflowRevisionUnavailableError } from '../revision-errors.ts';
import { buildForkCommitLostRaceError, reserveLegacyForkTargetRevision } from './fork-helpers.ts';

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
      const originalConditionalBatch = storage.conditionalBatch.bind(storage);
      const gate = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      let paused = false;
      // The fork's own commit now routes through `conditionalBatch` rather
      // than a plain `batch` under `ownership: 'none'` too (WFT-21, Codex
      // review items 1-3 — `buildForkCatalogEntryCondition` fences even
      // `'none'`-mode commits on the entry bytes once a revision is
      // persisted), so both write paths must be intercepted to still park
      // this test exactly at the fork's own commit.
      storage.batch = async (operations) => {
        if (!paused) {
          paused = true;
          entered.resolve();
          await gate.promise;
        }
        return originalBatch(operations);
      };
      storage.conditionalBatch = async (conditions, operations) => {
        if (!paused) {
          paused = true;
          entered.resolve();
          await gate.promise;
        }
        return originalConditionalBatch(conditions, operations);
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
      storage.conditionalBatch = originalConditionalBatch;
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

/**
 * WFT-21, Codex review round 5, P1: round 3's fix above reserved
 * `persistedRevision` only AFTER `resolveExecutableRegistrationOrRenamedNotFound()`
 * returned — using the SAME engine that started the source, whose local
 * definition cache was already populated, so that whole resolve never
 * genuinely awaited a loader. A FRESH engine instance with an empty local
 * cache exposes the real gap: `resolveExecutableRegistration()`'s own
 * `loadAndInstallSourceRevision()` awaits the source's loader, and a
 * concurrent `removeWorkflowRevision()` racing during THAT await could see
 * zero references — the reservation had not happened yet — delete and
 * finalize the sole candidate, and then have this same resolution's shared
 * load silently reinstall it via `catalog.install()`, papering over a
 * removal that already reported success.
 *
 * `resolveExecutableRegistrationForRevision()`'s new `onRevisionChosen` hook
 * (threaded through `LifecycleCallbacks`) now fires SYNCHRONOUSLY, before
 * that loader is ever awaited, and `fork()` reserves from inside it. This
 * test proves the timing directly: gate the loader, prove the reservation
 * is already visible to `removeWorkflowRevision()` while still parked
 * inside that gate — the round-3 test above could not observe this, since
 * its resolution never reached the loader at all.
 */
describe('fork() legacy-dynamic-source resolver race — WFT-21 Codex review round 5 P1', () => {
  it("reserves the resolver-chosen revision BEFORE awaiting the source's own loader, not after — closing the window a concurrent removeWorkflowRevision() could otherwise win while the load is still in flight", async () => {
    const storage = new MemoryStorage();
    const type = 'fork-legacy-resolver-race';
    const definitionV1 = workflow({ name: type, description: 'v1' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      return yield* ctx.waitForSignal<string>('go');
    });
    const revisionV1 = await revisionFor(type, definitionV1);

    // Engine A starts (and durably installs) the source run, then this
    // engine instance is disposed — engine B below shares only `storage`,
    // never engine A's own in-memory local source cache.
    const engineA = new Engine({ storage });
    let sourceId: string;
    try {
      engineA.registerSource(
        workflowSource(
          { name: type, location: './v1.ts', exportName: 'v1', revision: revisionV1 },
          async () => ({ v1: definitionV1 }),
        ),
      );
      const sourceHandle = await engineA.start(type, null, { id: 'fork-legacy-resolver-source' });
      sourceId = sourceHandle.id;

      // Simulate a legacy (pre-revision-pinning) record, as round 3's test
      // does, so no durable state reference protects `revisionV1` either —
      // the in-flight reservation is the ONLY thing that can.
      const stateBytes = await storage.get(KEYS.workflow(sourceId));
      const legacyState = { ...(decode(stateBytes!) as Record<string, unknown>) };
      delete legacyState['revision'];
      await storage.put(KEYS.workflow(sourceId), encode(legacyState));
    } finally {
      engineA[Symbol.dispose]();
    }

    // A FRESH engine instance — its own empty `sources.resolved` cache
    // forces a genuine loader await for the fork below, unlike round 3's
    // same-engine test.
    const engineB = new Engine({ storage });
    try {
      const gate = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      engineB.registerSource(
        workflowSource(
          { name: type, location: './v1.ts', exportName: 'v1', revision: revisionV1 },
          async () => {
            entered.resolve();
            await gate.promise;
            return { v1: definitionV1 };
          },
        ),
      );

      // Default fork — no `options.revision` — onto the legacy source's
      // sole registered candidate.
      const forkPromise = engineB.fork(sourceId);
      await entered.promise;

      // Parked exactly inside the resolver's own loader await. Before this
      // fix, `legacyResolvedInFlightRevision` was assigned only after this
      // whole resolve returned, so nothing reserved `revisionV1` yet here
      // and this removal would have wrongly succeeded.
      const refused = await removeWorkflowRevision(engineB, type, revisionV1);
      expect(refused.removed).toBe(false);
      if (!refused.removed && refused.reason === 'referenced') {
        expect(refused.references.inFlightStarts).toBe(1);
      } else {
        throw new Error(`expected a "referenced" refusal, got ${JSON.stringify(refused)}`);
      }

      gate.resolve();
      const forked = await forkPromise;
      const forkedState = await engineB.get(forked.id);
      expect(forkedState?.revision).toBe(revisionV1);

      // Reservation released once the fork settles.
      expect(getInternals(engineB).inFlightStartsByRevision.size).toBe(0);

      await engineB.signal(forked.id, 'go', 'done');
      await expect(forked.result()).resolves.toBe('done');
    } finally {
      engineB[Symbol.dispose]();
    }
  });
});

/**
 * WFT-21, Codex review round 13, P2: neither round 3's nor round 5's test
 * above exercises the case `reserveLegacyForkTargetRevision`'s own guard
 * exists to catch — the catalog's active pointer for `type` ALREADY equal
 * to the resolver's chosen sole candidate before `fork()`'s early
 * `reserveInFlightStart(internals, sourceState.type, targetRevision)` runs.
 * `targetRevision` itself is `undefined` (legacy source, no `options.revision`),
 * but `reserveInFlightStart`'s own `revisionOverride ?? resolveActive(type)?.revision`
 * fallback resolves it to the active pointer's revision — the common case
 * once a type has been activated at all.
 *
 * Before this fix, `fork()` passed that same pre-fallback `targetRevision`
 * (still `undefined`) — not `inFlightRevision`, what the early reservation
 * actually reserved — into `reserveLegacyForkTargetRevision()`. Its
 * `persistedRevision === targetRevision` guard then compared a real,
 * defined revision against `undefined`, which is never equal, so it
 * reserved `revisionV1` a SECOND time even though the early reservation
 * already covered it — a transient over-count for the fork's duration
 * (both reservations are released correctly in `fork()`'s own `finally`,
 * so nothing leaks or under-counts once the fork settles).
 */
describe('fork() legacy-dynamic-source double-reservation — WFT-21 Codex review round 13 P2', () => {
  it('reserves the resolved revision only ONCE when the catalog active pointer already equals it, not twice', async () => {
    const storage = new MemoryStorage();
    const type = 'fork-legacy-active-pointer-match';
    const definitionV1 = workflow({ name: type, description: 'v1' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      return yield* ctx.waitForSignal<string>('go');
    });
    const revisionV1 = await revisionFor(type, definitionV1);

    const engine = new Engine({ storage });
    try {
      engine.registerSource(
        workflowSource(
          { name: type, location: './v1.ts', exportName: 'v1', revision: revisionV1 },
          async () => ({ v1: definitionV1 }),
        ),
      );
      const sourceHandle = await engine.start(type, null, { id: 'fork-legacy-active-source' });

      // Activate `revisionV1` as the catalog's advertised active pointer for
      // `type` — the common real-world state once a type has been deployed
      // at all — so `fork()`'s early `reserveInFlightStart` fallback
      // resolves to the SAME revision the resolver below will choose.
      const activation = await engine.workflows.activate(type, revisionV1);
      expect(activation.applied).toBe(true);

      // Simulate a legacy (pre-revision-pinning) record, as the round-3/5
      // tests above do, so `targetRevision` really is `undefined` and only
      // the active-pointer fallback (not a pinned `sourceState.revision`)
      // supplies a revision to the early reservation.
      const stateBytes = await storage.get(KEYS.workflow(sourceHandle.id));
      const legacyState = { ...(decode(stateBytes!) as Record<string, unknown>) };
      delete legacyState['revision'];
      await storage.put(KEYS.workflow(sourceHandle.id), encode(legacyState));

      const originalBatch = storage.batch.bind(storage);
      const originalConditionalBatch = storage.conditionalBatch.bind(storage);
      const gate = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      let paused = false;
      // The fork's own commit now routes through `conditionalBatch` rather
      // than a plain `batch` under `ownership: 'none'` too (WFT-21, Codex
      // review items 1-3 — `buildForkCatalogEntryCondition` fences even
      // `'none'`-mode commits on the entry bytes once a revision is
      // persisted), so both write paths must be intercepted to still park
      // this test exactly at the fork's own commit.
      storage.batch = async (operations) => {
        if (!paused) {
          paused = true;
          entered.resolve();
          await gate.promise;
        }
        return originalBatch(operations);
      };
      storage.conditionalBatch = async (conditions, operations) => {
        if (!paused) {
          paused = true;
          entered.resolve();
          await gate.promise;
        }
        return originalConditionalBatch(conditions, operations);
      };

      const forkPromise = engine.fork(sourceHandle.id);
      await entered.promise;

      // Parked at the fork's own commit: both the early reservation (via
      // the active-pointer fallback) and, before this fix, a SECOND
      // erroneous reservation from `reserveLegacyForkTargetRevision` would
      // already have run. Read the reservation count directly — unlike the
      // round-3/5 tests above, `revisionV1` is also the ACTIVE revision
      // here, so `removeWorkflowRevision()` would refuse with `reason:
      // 'active'` before ever reaching the `inFlightStarts` check, masking
      // the exact count this test needs to observe.
      expect(getInternals(engine).inFlightStartsByRevision.get(type)?.get(revisionV1)).toBe(1);

      storage.batch = originalBatch;
      storage.conditionalBatch = originalConditionalBatch;
      gate.resolve();
      const forked = await forkPromise;
      const forkedState = await engine.get(forked.id);
      expect(forkedState?.revision).toBe(revisionV1);

      // Both reservations (early + legacy-hook, whichever fired) released
      // cleanly once the fork settles — no leaked count either way.
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

describe('fork() vs. a concurrent start-new replacement of the SOURCE — WFT-21 Codex review, item 6', () => {
  it('rejects with ForkSourceReplacedError when the loaded source checkpoint already reflects a later generation than the sourceState read at the top of fork()', async () => {
    await using storage = new MemoryStorage();
    await using engine = new Engine({ storage });
    const raceWorkflow = workflow({ name: 'fork-race-checkpoint' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      yield* ctx.run(async () => 'step-one');
      return 'done';
    });
    engine.register(raceWorkflow);

    const sourceHandle = await engine.start('fork-race-checkpoint', null, {
      id: 'wf-fork-race-checkpoint',
    });
    await sourceHandle.result();
    const originalState = decode((await storage.get(KEYS.workflow(sourceHandle.id)))!) as Record<
      string,
      unknown
    >;
    expect(originalState['workflowExecutionToken']).toBeDefined();

    // Simulate a version-compatible `start-new` replacement that has
    // ALREADY produced its own step-1 checkpoint — its live checkpoint
    // bytes now carry the REPLACEMENT's token, while the `WorkflowState`
    // `fork()` reads at its own top (below) still needs to observe the
    // ORIGINAL — so mutate the checkpoint now, and restore the original
    // `WorkflowState` bytes for `fork()`'s own read (a real `start-new`
    // replacement commits both atomically; this isolates JUST the
    // checkpoint-vs-state correlation this fix adds).
    const replacementCheckpointBytes = decode(
      (await storage.get(KEYS.checkpoint(sourceHandle.id)))!,
    ) as Record<string, unknown>;
    replacementCheckpointBytes['workflowExecutionToken'] = 'replacement-checkpoint-token';
    await storage.put(KEYS.checkpoint(sourceHandle.id), encode(replacementCheckpointBytes));

    await expect(engine.fork(sourceHandle.id)).rejects.toThrow(ForkSourceReplacedError);
  });

  it('rejects with ForkSourceReplacedError when the source is replaced AFTER the checkpoint correlates cleanly but BEFORE the pre-commit revalidation', async () => {
    class ReplaceOnSecondStateReadStorage extends MemoryStorage {
      #stateReadCount = 0;
      #replacementBytes: Uint8Array | null = null;

      armReplacement(bytes: Uint8Array): void {
        this.#replacementBytes = bytes;
      }

      override async get(key: string): Promise<Uint8Array | null> {
        if (key === KEYS.workflow(sourceId) && this.#replacementBytes !== null) {
          this.#stateReadCount += 1;
          // First read: `fork()`'s own early `sourceState` read — return the
          // ORIGINAL bytes. Every read after that (the pre-commit
          // revalidation this fix adds) sees the replacement.
          if (this.#stateReadCount > 1) {
            return this.#replacementBytes;
          }
        }
        return super.get(key);
      }
    }

    let sourceId = '';
    await using storage = new ReplaceOnSecondStateReadStorage();
    await using engine = new Engine({ storage });
    const raceWorkflow = workflow({ name: 'fork-race-precommit' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      yield* ctx.run(async () => 'step-one');
      return 'done';
    });
    engine.register(raceWorkflow);

    const sourceHandle = await engine.start('fork-race-precommit', null, {
      id: 'wf-fork-race-precommit',
    });
    sourceId = sourceHandle.id;
    await sourceHandle.result();

    const originalStateBytes = (await storage.get(KEYS.workflow(sourceHandle.id)))!;
    const replacedState = { ...(decode(originalStateBytes) as Record<string, unknown>) };
    replacedState['workflowExecutionToken'] = 'replacement-run-token-before-commit';
    replacedState['revision'] = 'sha256:replacement-revision-before-commit';
    storage.armReplacement(encode(replacedState));

    await expect(engine.fork(sourceHandle.id)).rejects.toThrow(ForkSourceReplacedError);
  });

  it('tolerates a source checkpoint with no workflowExecutionToken (a pre-upgrade record) — the correlation check has nothing to compare, so the fork proceeds', async () => {
    await using storage = new MemoryStorage();
    await using engine = new Engine({ storage });
    const raceWorkflow = workflow({ name: 'fork-race-legacy-checkpoint' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      yield* ctx.run(async () => 'step-one');
      return 'done';
    });
    engine.register(raceWorkflow);

    const sourceHandle = await engine.start('fork-race-legacy-checkpoint', null, {
      id: 'wf-fork-race-legacy-checkpoint',
    });
    await sourceHandle.result();
    // `sourceState.workflowExecutionToken` stays defined; only the
    // CHECKPOINT'S token is stripped, simulating a checkpoint chain that
    // predates the field.
    const legacyCheckpoint = {
      ...(decode((await storage.get(KEYS.checkpoint(sourceHandle.id)))!) as Record<
        string,
        unknown
      >),
    };
    delete legacyCheckpoint['workflowExecutionToken'];
    await storage.put(KEYS.checkpoint(sourceHandle.id), encode(legacyCheckpoint));

    const forkHandle = await engine.fork(sourceHandle.id);
    await expect(forkHandle.result()).resolves.toBe('done');
  });

  it('tolerates a source WorkflowState with no workflowExecutionToken (a pre-upgrade record) — the pre-commit revalidation has nothing to compare, so the fork proceeds', async () => {
    await using storage = new MemoryStorage();
    await using engine = new Engine({ storage });
    const raceWorkflow = workflow({ name: 'fork-race-legacy-state' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      yield* ctx.run(async () => 'step-one');
      return 'done';
    });
    engine.register(raceWorkflow);

    const sourceHandle = await engine.start('fork-race-legacy-state', null, {
      id: 'wf-fork-race-legacy-state',
    });
    await sourceHandle.result();
    // Strip the token from BOTH the checkpoint and the state, so the FIRST
    // correlation check also has nothing to compare (both sides
    // token-less) and lets execution reach the pre-commit revalidation's
    // own early-return branch.
    const legacyCheckpoint = {
      ...(decode((await storage.get(KEYS.checkpoint(sourceHandle.id)))!) as Record<
        string,
        unknown
      >),
    };
    delete legacyCheckpoint['workflowExecutionToken'];
    await storage.put(KEYS.checkpoint(sourceHandle.id), encode(legacyCheckpoint));

    const legacyState = {
      ...(decode((await storage.get(KEYS.workflow(sourceHandle.id)))!) as Record<string, unknown>),
    };
    delete legacyState['workflowExecutionToken'];
    await storage.put(KEYS.workflow(sourceHandle.id), encode(legacyState));

    const forkHandle = await engine.fork(sourceHandle.id);
    await expect(forkHandle.result()).resolves.toBe('done');
  });
});

describe('catalog.install() vs. a concurrent removeCatalogEntry() tombstone — WFT-21 Codex review items 1-3', () => {
  it("fails a fork's commit closed under ownership: 'none' too, not just 'lease'/'workflow-lease' (item 2 — buildForkCatalogEntryCondition's 'none' no-op)", async () => {
    const storage = new MemoryStorage();
    const type = 'fork-catalog-race-none';
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

    // Default `ownership: 'none'` — the exact mode `buildForkCatalogEntryCondition`
    // used to skip entirely.
    await using engine = new Engine({ storage });
    engine.registerSource(
      workflowSource(
        { name: type, location: './v1.ts', exportName: 'v1', revision: revisionV1 },
        async () => ({ v1: definitionV1 }),
      ),
    );
    const sourceHandle = await engine.start(type, null, { id: 'fork-catalog-race-none-source' });

    engine.registerSource(
      workflowSource(
        { name: type, location: './v2.ts', exportName: 'v2', revision: revisionV2 },
        async () => ({ v2: definitionV2 }),
      ),
    );
    await engine.resolveWorkflowSource(type, revisionV2);
    expect(await getWorkflowCatalog(engine).hasInstalled(type, revisionV2)).toBe(true);

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

    // Park the fork's own commit exactly at its `conditionalBatch` call —
    // under `'none'` this now carries the same catalog-entry condition
    // `'lease'`/`'workflow-lease'` already had.
    const forkPromise = engine.fork(sourceHandle.id, { revision: revisionV2 });
    await entered.promise;

    storage.conditionalBatch = originalConditionalBatch;
    // `removeWorkflowRevision()` checks THIS process's own in-memory
    // `inFlightStartsByRevision` — the fork issued against `engine` itself
    // already reserved `revisionV2` there, so removing through the SAME
    // engine instance would see it as `'referenced'` rather than exercising
    // the durable-commit race this test targets. A separate, unleased
    // engine sharing storage is a legitimate separate caller (mirrors the
    // round-1 test above), simulating the cross-process case where the
    // remover's own process never took that reservation.
    const remover = new Engine({ storage });
    let removed;
    try {
      removed = await removeWorkflowRevision(remover, type, revisionV2);
    } finally {
      remover[Symbol.dispose]();
    }
    expect(removed).toEqual({ removed: true });

    gate.resolve();
    let forkError: unknown;
    try {
      await forkPromise;
    } catch (error) {
      forkError = error;
    }
    expect(forkError).toBeInstanceOf(WorkflowRevisionUnavailableError);
    expect((forkError as WorkflowRevisionUnavailableError).reason).toBe('not-installed');
    expect((forkError as WorkflowRevisionUnavailableError).revision).toBe(revisionV2);

    const runs = await engine.list({ type });
    expect(runs.items).toHaveLength(1);
    expect(runs.items[0]?.id).toBe(sourceHandle.id);
    expect(await storage.get(KEYS.catalogEntry(type, revisionV2))).toBeNull();

    await engine.signal(sourceHandle.id, 'go', 'done');
    await expect(sourceHandle.result()).resolves.toBe('done');
  });

  it('refuses to resurrect a revision from a DIFFERENT engine instance racing the exact window a concurrent removal has deleted the entry and written its tombstone, but not yet finalized it (items 1 & 3 — catalog.install() itself, the shared root cause of both the legacy fork resolver hook and the explicit-revision fork load)', async () => {
    const storage = new MemoryStorage();
    const type = 'fork-catalog-race-install';
    const definitionV1 = workflow({ name: type, description: 'v1' }).execute(async function* (
      ctx: WorkflowContext,
    ) {
      return yield* ctx.waitForSignal<string>('go');
    });
    const revisionV1 = await revisionFor(type, definitionV1);
    const entryKey = KEYS.catalogEntry(type, revisionV1);
    const tombstoneKey = KEYS.catalogTombstone(type, revisionV1);

    // Engine B boots and restores its catalog snapshot BEFORE v1 is ever
    // installed anywhere — so its one-time restore
    // (`ensureWorkflowCatalogReady`'s `restoreWorkflowCatalog` call) never
    // caches v1 into its own process-local `#entries` map at all.
    // `WorkflowCatalog.install()`'s FIRST check is that local cache — a
    // cache HIT returns immediately without ever touching durable storage,
    // so this ordering is required for engine B's later `install()` call to
    // actually reach the durable read/write path this test targets, rather
    // than short-circuiting on stale in-memory bookkeeping.
    const engineB = new Engine({ storage });
    engineB.registerSource(
      workflowSource(
        { name: type, location: './v1.ts', exportName: 'v1', revision: revisionV1 },
        async () => ({ v1: definitionV1 }),
      ),
    );
    expect(await engineB.workflows.listRevisions(type)).toEqual([]);

    const engineA = new Engine({ storage });
    engineA.registerSource(
      workflowSource(
        { name: type, location: './v1.ts', exportName: 'v1', revision: revisionV1 },
        async () => ({ v1: definitionV1 }),
      ),
    );
    // Install v1 durably via engine A, then leave it unreferenced so it is
    // removable.
    await engineA.resolveWorkflowSource(type, revisionV1);
    expect(await getWorkflowCatalog(engineA).hasInstalled(type, revisionV1)).toBe(true);

    // `removeWorkflowRevision()`'s delete-and-tombstone write
    // (`catalog.remove()`) and its later tombstone finalization
    // (`finalizeCatalogTombstone()`) are TWO SEPARATE `conditionalBatch`
    // commits within the same call — the entry is durably absent with its
    // tombstone durably present for the whole gap between them. Pause
    // exactly there: after the delete-and-tombstone batch commits (`result`
    // is `true`), before returning control to `removeWorkflowRevision()`'s
    // caller.
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const originalConditionalBatch = storage.conditionalBatch.bind(storage);
    let paused = false;
    storage.conditionalBatch = async (conditions, operations) => {
      const result = await originalConditionalBatch(conditions, operations);
      const isDeleteAndTombstoneWrite =
        result &&
        operations.some((op) => op.type === 'delete' && op.key === entryKey) &&
        operations.some((op) => op.type === 'put' && op.key === tombstoneKey);
      if (isDeleteAndTombstoneWrite && !paused) {
        paused = true;
        entered.resolve();
        await gate.promise;
      }
      return result;
    };

    const removalPromise = removeWorkflowRevision(engineA, type, revisionV1);
    await entered.promise;

    // Parked mid-removal: the entry is durably absent, the tombstone is
    // durably present.
    expect(await storage.get(entryKey)).toBeNull();
    expect(await storage.get(tombstoneKey)).not.toBeNull();

    // Engine B — the DIFFERENT instance set up above, which has never
    // cached this revision locally — tries to (re)install the exact same
    // revision during this window: the real shape of a fork's
    // dynamic-source load racing a concurrent removal.
    try {
      let reinstallError: unknown;
      try {
        await engineB.resolveWorkflowSource(type, revisionV1);
      } catch (error) {
        reinstallError = error;
      }
      expect(reinstallError).toBeInstanceOf(WorkflowRevisionUnavailableError);
      expect((reinstallError as WorkflowRevisionUnavailableError).reason).toBe('not-installed');
      expect((reinstallError as WorkflowRevisionUnavailableError).revision).toBe(revisionV1);

      // No resurrection: the entry stayed durably absent throughout.
      expect(await storage.get(entryKey)).toBeNull();
      expect(await getWorkflowCatalog(engineB).hasInstalled(type, revisionV1)).toBe(false);
    } finally {
      engineB[Symbol.dispose]();
    }

    // Release the parked removal — it finalizes the tombstone normally,
    // proving the reinstall attempt above did not disturb it.
    gate.resolve();
    storage.conditionalBatch = originalConditionalBatch;
    const removed = await removalPromise;
    expect(removed).toEqual({ removed: true });
    expect(await storage.get(tombstoneKey)).toBeNull();
  });

  it("fork() itself fails closed even when its target revision's load-and-install step races a FULL removal+finalization cycle that begins and ends while the load is in flight (WFT-21, Codex review round 4, P1 — verified NOT reachable through fork()'s real commit path)", async () => {
    // Codex round 4 P1 flagged `catalog/storage-io.ts`'s `writeCatalogEntry()`
    // itself: existence-based tombstone fencing only protects the window
    // BEFORE a removal finalizes, so a stale in-flight loader that started
    // before removal but installs after finalization could, in principle,
    // resurrect an already-removed revision. Investigated empirically
    // (scratch probes, not kept): a load that begins while its target
    // revision IS durably installed short-circuits on a durable
    // `resolveEntry()` read taken before the loader ever runs — it adopts a
    // durable hit into the engine's own process-local `#entries` cache and
    // never re-touches durable storage once the loader resolves, so
    // `catalog.install()` here writes nothing at all (no `conditionalBatch`
    // call, no resurrection). But this local cache goes STALE relative to
    // the concurrent removal — the engine believes the revision installed
    // successfully (`hasInstalled()` returns `true` from cache) even though
    // the durable entry stayed permanently absent. This test proves that
    // staleness never reaches a caller-visible resurrection: `fork()`'s own
    // commit-time catalog-entry condition (`buildCatalogEntryRevisionCondition`,
    // `start-commit.ts` — pre-existing, now reached under EVERY ownership
    // mode per item 2's fix) re-reads the entry fresh from durable storage
    // immediately before commit, independent of whatever the load-and-install
    // step believed, and fails closed with the same typed
    // `WorkflowRevisionUnavailableError('not-installed')` the items-1-3 fix
    // throws for the simpler pre-finalization window above.
    const storage = new MemoryStorage();
    const type = 'fork-catalog-race-post-finalization';
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
    const entryKeyV2 = KEYS.catalogEntry(type, revisionV2);
    const tombstoneKeyV2 = KEYS.catalogTombstone(type, revisionV2);

    const loadGate = Promise.withResolvers<void>();
    const loadEntered = Promise.withResolvers<void>();

    // Engine B pre-warms its catalog snapshot BEFORE V2 exists anywhere, so
    // its one-time boot sweep never caches V2 — see the sibling test above
    // for why this ordering is required to reach a real load path at all.
    const engineB = new Engine({ storage });
    engineB.registerSource(
      workflowSource(
        { name: type, location: './v1.ts', exportName: 'v1', revision: revisionV1 },
        async () => ({ v1: definitionV1 }),
      ),
    );
    expect(await engineB.workflows.listRevisions(type)).toEqual([]);

    // Engine A starts the source run on V1, then installs V2 durably.
    const engineA = new Engine({ storage });
    engineA.registerSource(
      workflowSource(
        { name: type, location: './v1.ts', exportName: 'v1', revision: revisionV1 },
        async () => ({ v1: definitionV1 }),
      ),
    );
    const sourceHandle = await engineA.start(type, null, {
      id: 'fork-catalog-race-post-finalization-source',
    });
    engineA.registerSource(
      workflowSource(
        { name: type, location: './v2.ts', exportName: 'v2', revision: revisionV2 },
        async () => ({ v2: definitionV2 }),
      ),
    );
    await engineA.resolveWorkflowSource(type, revisionV2);
    expect(await getWorkflowCatalog(engineA).hasInstalled(type, revisionV2)).toBe(true);

    // Engine B registers V2 with a pausable loader and forks onto it — V2 IS
    // durably installed at this moment, but engine B's own local
    // resolved-definition cache is empty for this exact key, so this falls
    // through to a real load rather than short-circuiting immediately.
    engineB.registerSource(
      workflowSource(
        { name: type, location: './v2.ts', exportName: 'v2', revision: revisionV2 },
        async () => {
          loadEntered.resolve();
          await loadGate.promise;
          return { v2: definitionV2 };
        },
      ),
    );
    const forkPromise = engineB.fork(sourceHandle.id, { revision: revisionV2 });
    await loadEntered.promise;

    // Fully remove AND finalize V2 while engine B's fork is parked mid-load
    // — unlike the sibling test above, this runs the removal to full
    // completion (tombstone gone, not just present) before the load resumes.
    const removed = await removeWorkflowRevision(engineA, type, revisionV2);
    expect(removed).toEqual({ removed: true });
    expect(await storage.get(entryKeyV2)).toBeNull();
    expect(await storage.get(tombstoneKeyV2)).toBeNull();

    loadGate.resolve();
    let forkError: unknown;
    try {
      await forkPromise;
    } catch (error) {
      forkError = error;
    }

    expect(forkError).toBeInstanceOf(WorkflowRevisionUnavailableError);
    expect((forkError as WorkflowRevisionUnavailableError).reason).toBe('not-installed');
    expect((forkError as WorkflowRevisionUnavailableError).workflowType).toBe(type);
    expect((forkError as WorkflowRevisionUnavailableError).revision).toBe(revisionV2);

    // No resurrection observable anywhere: the durable entry stayed absent,
    // and the only run for this type is the original V1 source.
    expect(await storage.get(entryKeyV2)).toBeNull();
    const runs = await engineA.list({ type });
    expect(runs.items).toHaveLength(1);
    expect(runs.items[0]?.id).toBe(sourceHandle.id);
    expect(runs.items[0]?.revision).toBe(revisionV1);

    engineA[Symbol.dispose]();
    engineB[Symbol.dispose]();
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

describe('reserveLegacyForkTargetRevision — WFT-21 Codex review round 3 P1', () => {
  it("reserves persistedRevision when it differs from reservedRevision — fork()'s own onRevisionChosen hook call site, passing what the early reservation actually reserved (undefined when the catalog has no active pointer for the type yet)", () => {
    const internals = { inFlightStartsByRevision: new Map() } as never;
    const reserved = reserveLegacyForkTargetRevision(internals, 'checkout', undefined, 'sha256:v1');
    expect(reserved).toBe('sha256:v1');
  });

  it("skips reserving (returns undefined, no increment) when persistedRevision already equals reservedRevision — reachable through fork()'s own call site whenever the catalog's active pointer for the type already resolves to the resolver's chosen revision (Codex review round 13, P2 — see the end-to-end double-reservation regression test above); exercised directly here too so this function's own double-reservation guard stays covered independently of that caller", () => {
    const internals = { inFlightStartsByRevision: new Map() } as never;
    const reserved = reserveLegacyForkTargetRevision(
      internals,
      'checkout',
      'sha256:v1',
      'sha256:v1',
    );
    expect(reserved).toBeUndefined();
    expect(
      (internals as { inFlightStartsByRevision: Map<string, unknown> }).inFlightStartsByRevision
        .size,
    ).toBe(0);
  });
});

describe('catalog.install() vs. a removal that fully completes WHILE a stale loader is mid-flight — WFT-21, Codex review round 14, P1 item Q7jH (durable removal-generation fence)', () => {
  it("fails closed instead of resurrecting the revision, even though both the entry and tombstone keys read null again by the time the stale loader's install() call runs", async () => {
    const storage = new MemoryStorage();
    const type = 'removal-generation-fence';
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
    const entryKeyV2 = KEYS.catalogEntry(type, revisionV2);
    const tombstoneKeyV2 = KEYS.catalogTombstone(type, revisionV2);

    // Engine A starts the source run on v1. Deliberately does NOT install v2
    // at all yet — the durable read at the top of engine B's own resolution
    // below (`resolveCachedOrHandle`) genuinely MISSES v2, reaching
    // `runSharedSourceLoad` directly (interleaving 2 of the P1 residual: a
    // load whose durable `resolveEntry()` read misses the target revision
    // entirely, rather than adopting a durable hit into a process-local
    // cache).
    const engineA = new Engine({ storage });
    engineA.registerSource(
      workflowSource(
        { name: type, location: './v1.ts', exportName: 'v1', revision: revisionV1 },
        async () => ({ v1: definitionV1 }),
      ),
    );
    const sourceHandle = await engineA.start(type, null, {
      id: 'removal-generation-fence-source',
    });
    expect(await storage.get(entryKeyV2)).toBeNull();

    // Engine B forks onto v2 with a pausable loader — its own durable read
    // misses v2 (never installed anywhere yet), so this reaches
    // `runSharedSourceLoad`, which captures the removal-generation counter
    // (absent — `null`, "never removed") BEFORE the loader below ever runs.
    const engineB = new Engine({ storage });
    const loadGate = Promise.withResolvers<void>();
    const loadEntered = Promise.withResolvers<void>();
    engineB.registerSource(
      workflowSource(
        { name: type, location: './v2.ts', exportName: 'v2', revision: revisionV2 },
        async () => {
          loadEntered.resolve();
          await loadGate.promise;
          return { v2: definitionV2 };
        },
      ),
    );
    const forkPromise = engineB.fork(sourceHandle.id, { revision: revisionV2 });
    await loadEntered.promise;

    // WHILE engine B's loader is parked, engine A performs a FULL,
    // independent install-then-remove-then-finalize cycle of the EXACT same
    // revision — e.g. an operator deploying and then retiring v2 entirely
    // while B's stale load is still in flight. This bumps the durable
    // removal-generation counter past what B's loader captured above, and
    // leaves both the entry and tombstone keys reading `null` again — the
    // exact "indistinguishable from never installed" state the P1 review
    // flagged as unprotected before this fix.
    engineA.registerSource(
      workflowSource(
        { name: type, location: './v2.ts', exportName: 'v2', revision: revisionV2 },
        async () => ({ v2: definitionV2 }),
      ),
    );
    await engineA.resolveWorkflowSource(type, revisionV2);
    expect(await getWorkflowCatalog(engineA).hasInstalled(type, revisionV2)).toBe(true);
    const removed = await removeWorkflowRevision(engineA, type, revisionV2);
    expect(removed).toEqual({ removed: true });
    expect(await storage.get(entryKeyV2)).toBeNull();
    expect(await storage.get(tombstoneKeyV2)).toBeNull();
    expect(await storage.get(KEYS.catalogRemovalGeneration(type, revisionV2))).not.toBeNull();

    // Resume engine B's stale loader. Before this fix, `catalog.install()`
    // saw both the entry AND tombstone keys as `null` and reinstalled v2
    // unconditionally — the fenced write now additionally CAS-guards on the
    // removal-generation counter it captured before the loader ran, which
    // has since advanced, so the write loses its CAS and fails closed.
    loadGate.resolve();
    let forkError: unknown;
    try {
      await forkPromise;
    } catch (error) {
      forkError = error;
    }
    expect(forkError).toBeInstanceOf(WorkflowRevisionUnavailableError);
    expect((forkError as WorkflowRevisionUnavailableError).reason).toBe('not-installed');
    expect((forkError as WorkflowRevisionUnavailableError).workflowType).toBe(type);
    expect((forkError as WorkflowRevisionUnavailableError).revision).toBe(revisionV2);

    // No resurrection: the entry stayed durably absent, and
    // `removeWorkflowRevision()`'s earlier `{ removed: true }` result above
    // stays truthful — no entry was recreated behind its back.
    expect(await storage.get(entryKeyV2)).toBeNull();
    expect(await getWorkflowCatalog(engineB).hasInstalled(type, revisionV2)).toBe(false);
    const runs = await engineA.list({ type });
    expect(runs.items).toHaveLength(1);
    expect(runs.items[0]?.id).toBe(sourceHandle.id);
    expect(runs.items[0]?.revision).toBe(revisionV1);

    engineA[Symbol.dispose]();
    engineB[Symbol.dispose]();
  });
});

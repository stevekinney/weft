# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.24.2] - 2026-09-11

### Added

- `canResolveRevisionLocally(internals, type, revision)` (WFT-19, `core/engine/dynamic-source-execution.ts`, internal): the shared predicate behind both `resolveExecutableRegistrationForRevision()`'s classification and the ADR-0002 workflow-lease reclaim-eligibility gate — an eager registration is always resolvable; a dynamic source with `revision === undefined` is resolvable only with exactly one registered candidate; a dynamic source with a defined `revision` is resolvable exactly when that revision is among this process's currently registered candidates. Extracting this into one function is what makes the Fixed entries below share one classification instead of two that could drift.
- Schedule revision policy and worker-protocol revision propagation (WFT-20), building on WFT-17/18's `WorkflowState.revision`. `ScheduleOptions`/`ScheduleUpdateOptions` gain `revisionPolicy?: ScheduleRevisionPolicy` (`'active-at-fire' | 'pinned'`, new root-exported type), and `ScheduleMetadata` gains a required `revisionPolicy` (defaults `'active-at-fire'`, byte-for-byte the pre-WFT-20 behavior) plus an optional `pinnedRevision`. `'pinned'` captures, at create/update time, the revision that would run right now — reusing the same resolver a fresh `engine.start()` uses — and every future occurrence resolves that EXACT revision, never whatever happens to be active at fire time; the fired run's own `WorkflowState.revision` equals the pin. For an eagerly-registered workflow type, a pin is a real, checkable commitment: fire time re-checks the process's `registeredCatalogRevisions` entry for an EXACT match rather than silently falling back to active-at-fire behavior the way run recovery's own pin-fallback does (a schedule's pin is a forward-looking promise, recovery's is "this process only ever runs what it loaded" — the two cases are not the same and must not share the fallback). An unavailable pin (removed via `removeWorkflowRevision()`, or an eager type's process-local registration no longer matching) throws `WorkflowRevisionUnavailableError` at the next fire and pauses the schedule through the existing `pauseScheduleAfterTimerFailure` path — an operator sees the schedule stop, not a silently-never-firing `'active'` schedule. `updateSchedule()`'s `revisionPolicy` follows the existing "omitted retains persisted value" rule with one nuance: passing `'pinned'` ALWAYS re-resolves and re-captures against whatever is active right now, even when already pinned — never a no-op — and passing `'active-at-fire'` clears any captured pin. The pinned-schedule create/update write is fenced (`buildCatalogEntryRevisionCondition`, the same primitive `start()` uses) against a concurrent `removeWorkflowRevision()` landing between capture and commit, closing the identical TOCTOU class WFT-17 closed for `start()`. `WorkflowRevisionReferenceCounts.pinnedSchedules` (previously a permanent `0` stub since WFT-12) is now a real, bounded `storage.scan('schedule:')` count of non-cancelled `revisionPolicy: 'pinned'` schedules pinned to exactly that revision — see the Changed entry below. New CLI flag `weft schedule create --revision-policy <active-at-fire|pinned>`. See [Schedule revision policy](documentation/guides/workflow-versioning.md#schedule-revision-policy-wft-20).

- Worker-protocol revision echo and staleness validation (WFT-20), across both worker protocols the codebase carries. **Internal in-process Worker execution mode** (`workflowExecutionMode: 'worker'`): the `run` inbound message and the `checkpoint`/`completed`/`failed` outbound messages gain an optional `workflowRevision`, carrying the starting run's persisted `WorkflowState.revision`; `WorkerTurnWatchdog`/`WorkerProtocolGuard` validate every outbound message for a workflow's remaining turns — including `resume` turns, which never resend the field — against the revision captured at that workflow's `run` turn, rejecting a mismatched or missing echo when a revision was expected (fully internal, same-release channel: no back-compat asymmetry). `WorkerExecutionStrategy`'s per-workflow captured-revision map is now also cleared on every worker-fault path that synthesizes a `failed` message directly (protocol violation, turn timeout, crash, log abuse, realm-ready failure) — not just the ordinary terminal-message settle path — so a long-lived worker-mode engine experiencing repeated faults doesn't accumulate one stale map entry per faulted workflow ID for the life of the strategy. **RemoteWorker distributed protocol** (WebSocket + HTTP long-poll): `TaskDispatch`/`RemoteTaskBase`/`TaskMessage` gain an optional `workflowRevision`, echoed by the worker on `taskResult`/the long-poll result request and validated at completion — the WebSocket transport is ADDITIVE (a missing echo is tolerated only when the in-flight registry entry itself carries none, e.g. an older worker SDK; a present-and-wrong echo always rejects), while long-poll is STRICT (no live in-flight entry to fall back on, so once any `TaskDispatch` caller supplies a revision for an operation, every worker completing it must echo it back or receive `403`) — see [the protocol doc](documentation/reference/remote-worker-protocol.md#taskresult) for the exact rule. `dispatchTaskImpl` also gains a dispatch-TIME staleness gate: when a caller supplies both `workflowId` and `workflowRevision`, the dispatch is rejected with a bounded error BEFORE any worker capacity is reserved or ledger record written if the persisted run has since moved to a different revision (e.g. displaced by a `start-new` restart). This check's own workflow-state read now also fences the ledger commit that follows it: the exact bytes read are carried as an additional `conditionalBatch` precondition on BOTH the WebSocket claim and the long-poll `queued`-record create, so a `start-new` landing in the gap between the pre-check and the commit loses that commit's compare-and-swap atomically instead of racing past a read-then-write check. A redispatch that reuses an already-`queued` ledger record (a lost create race, or a requeue) now carries that durable record's OWN `workflowRevision` on the long-poll match hint, never the calling `TaskDispatch`'s, so two concurrent dispatches for one `operationId` with different revisions can't leave the hint disagreeing with the durable record a worker actually claims against. An invalid caller-supplied `workflowRevision` (empty, or over the bounded-identifier byte limit) is now rejected before it ever reaches a ledger write, rather than silently producing a durable record that fails to decode on every later read. `weft conformance` dispatches with a `workflowRevision` and asserts the reference worker echoes it back correctly (a new `revision echo` check). Recovery (`task-ledger-recovery.ts`) now restores a recovered in-flight task's `workflowRevision` into the rehydrated `WorkerRegistry` entry, so a WebSocket completion arriving after a server restart is still revision-checked instead of silently skipping that guard. The in-process worker's own bounded-fallback failure message (sent when a checkpoint/terminal message is too large to forward) now also stamps the active turn's captured revision, so it survives the host's strict per-turn revision check instead of being rejected as a protocol violation and discarding the whole worker. `WorkerExecutionRequirementInput.workflowRevision` (a pre-existing, unrelated client-declared routing constraint) and `WorkerWorkflowContract.workflowRevision` (a pre-existing manifest content digest) are untouched by this change — the new field is a plain top-level wire echo, populated by the `TaskDispatch` caller, never compared against either.

### Changed

- **`WorkflowRevisionReferenceCounts.pinnedSchedules` is no longer a permanent `0` stub** (WFT-20): it is now a real, bounded `storage.scan('schedule:')` count of non-cancelled `revisionPolicy: 'pinned'` schedules pinned to exactly that revision. `removeWorkflowRevision()` now correctly refuses a revision a pinned (and not cancelled) schedule still depends on, the identical WFT-17-precedent gap this closes for `nonTerminalRuns`.

### Fixed

- **`snapshotTailSequence()` no longer falls back to an unbounded reverse `storage.scan()` on a feed that has never been appended to** (WFT-150). `append()` has always written the fleet-event-tail record atomically alongside the first event since the file's initial commit, so "tail absent, events present" only arises from storage tampering or a partial restore — not a legacy pre-tail-record migration case, so no migration path is needed. The fallback is now bounded, reusing the existing `highestFleetEventSequence()` (reverse, `limit: 1`) instead of an unbounded scan, and once it confirms the store is genuinely virgin, persists a `{ sequence: -1 }` sentinel tail record (best-effort, via a `conditionalBatch` keyed off the tail key's absence, so a concurrent `append()` safely wins the race) so every subsequent call answers from `storage.get()` alone.
- **The explicit-id start fence's pre-CAS ABA is closed with a durable, permanently-retained per-id generation counter** (WFT-153, closing the residual WFT-152 left open). `start-terminal-conflict-purge.ts`'s duplicate-id `conditionalBatch` precondition compares the observed `wf:<id>` VALUE, so on its own it cannot distinguish "this id was never used" from "a run existed here and was purged": if a racing winner completed and was purged (or swept by retention) before a slower loser's create batch committed, `wf:<id>` was absent again, the value-only condition matched, and BOTH starts executed—a duplicate run, not the hang WFT-152 closed. A new reserved key prefix, `wf-gen:<id>` (`storage/generation-keys.ts`'s `GENERATION_KEYS.workflowGeneration`, spread into `KEYS`), is a monotonic per-workflow-id counter encoded exactly like `wf-owner-epoch` (an 8-byte big-endian uint64 via `core/engine/generation-codec.ts`, which re-exports `lease-codec.ts`'s `encodeEpoch`/`decodeEpoch` under generation-specific names). Like `wf-owner-epoch`, it is **permanently retained**—never deleted by release, purge, retention, or a mode downgrade—but unlike `wf-owner-epoch` (written only under `ownership: 'workflow-lease'`), it is written under EVERY ownership mode, since the ABA hole exists under `'none'`/`'lease'` too. It is bumped (`(observed ?? 0) + 1`, never a literal—mirroring `workflow-claim-transitions.ts`'s epoch-rotation pattern) in the SAME atomic batch that deletes `wf:<id>` on purge—both `engine.purge()`/the retention sweep (`bulk-operations-purge.ts`'s `purgeWorkflow`, via the new `foldWorkflowGenerationBumpForPurge`, `core/engine/workflow-generation-fence.ts`—CAS-guarded on the observed generation bytes when the storage backend reports `conditionalBatch` support, and unconditioned only on a backend that honestly reports no such support, closing a residual ABA between two OVERLAPPING purges of the same id that a chatgpt-codex-connector review round found in the initial unconditioned version: without the CAS guard, a delayed purge's stale bump could overwrite a newer generation an intervening purge-and-reuse of the same id had already written, rolling the "monotonic" counter backward) and an `onTerminalConflict: 'start-new'` restart's own displacing purge (`prepareTerminalRunPurge`, via `buildWorkflowGenerationBumpOperation`)—and is explicitly excluded from the purge delete-set, mirroring the existing `wf-teardown-deadletter:` exclusion. An explicit-id start's `duplicateIdCondition` now carries an ADDITIONAL `duplicateIdGenerationCondition` on the observed generation bytes (`resolveTerminalConflictForRestart`, `start-terminal-conflict-purge.ts`): a purge landing in the read-to-commit gap always changes `wf-gen:<id>` even though `wf:<id>` reads identically absent, so the stale loser's condition on the pre-purge generation now fails where the value-only comparison could not detect anything wrong. `TaggedStartCondition['source']` gains a `'duplicate-id-generation'` variant (`start-commit.ts`), checked with the same positive-evidence precedence as the existing `'duplicate-id'` check, so a loss attributable to the generation condition is now correctly attributed to `WorkflowAlreadyExistsError` immediately rather than falling through to `attributeLostStartPreconditionOrRetry`'s elimination-based fallback (`start-precondition-attribution.ts`, whose doc previously named this exact case as an untracked residual). The `'start-new'` restart's own displacing purge bumps the generation from the SAME observed bytes its own outer `duplicateIdGenerationCondition` was built from—one read, threaded through `prepareTerminalRunPurge`, rather than a second independent read—so the restart's own commit can never fence itself out on its own legitimate restart. `start-terminal-conflict-purge.ts`'s `KNOWN LIMITATION` JSDoc block (from the PR #959 review) and the matching caveat paragraph in [Recovery and Deploys § One engine per durable store](documentation/guides/recovery-and-deploys.md#one-engine-per-durable-store) are both updated to describe the closed gap instead of an open one.
- **`startOrSignal`'s same-`signalId` convergence no longer throws a spurious `StartOrSignalConflictError` for a loser that reads the winner's run AFTER it has already reached a terminal status** (found while adding the WFT-153 fence above, which—by adding one more `storage.get()` to the caller-`id` winner's own commit path—made this latent gap in `start-or-signal-resolution.ts` reachable deterministically instead of only in a narrow, previously-unobserved timing window; it is a genuine pre-existing correctness gap, not new behavior WFT-153 introduces). `resolveCallerIdWinnerOrRetry()` previously threw unconditionally whenever EITHER of its two reads found a terminal record and `onTerminalConflict !== 'start-new'`, even when the terminal run's `sigres:` accepted-response marker proves THIS caller's own `signalId` was the one the winner's atomic create batch delivered—the documented "concurrent absent-target callers... converge to one workflow and one signal" contract. Both terminal-conflict branches now check `wasSignalAcceptedByWinner()` (a `storageHas` read of `KEYS.signalAcceptedResponse(winnerId, signalName, signalId)`, the same marker `buildCreateBatchSignalOperations` writes atomically with the create) before throwing, converging on the winner's handle instead of conflicting when it matches.

### Persisted-data compatibility

- **New reserved key prefix `wf-gen:<id>` (WFT-153)**: `CURRENT_PERSISTED_DATA_SCHEMA_VERSION` is **not bumped** (stays `2`), following the same WFT-9/WFT-10 precedent [the workflow-versioning guide documents](documentation/guides/workflow-versioning.md#revisions-and-the-catalog)—an entirely new, additive key prefix that no prior Weft version ever wrote, reshaping no existing persisted record's bytes or fields, so there is nothing for an older or newer reader to misinterpret. A store upgraded from a pre-WFT-153 release simply has zero `wf-gen:` keys until the first purge or `onTerminalConflict: 'start-new'` restart writes one; a read against a never-bumped id treats the key's absence as generation `0` (see `nextGenerationFromObservedBytes`), which is the correct "never used" starting point, not a migration gap.
- `ScheduleState` (persisted under `schedule:<id>`) gains a required `revisionPolicy` and an optional `pinnedRevision`. `CURRENT_PERSISTED_DATA_SCHEMA_VERSION` is **not bumped** (stays `2`): a pre-this-release record decodes with no `revisionPolicy` field at all, and `validation/schedule-revision.ts` defaults that to `'active-at-fire'` — the identical "absent means legacy, not corrupt" treatment `WorkflowState.revision` got in WFT-17 — rather than rejecting the record as malformed. An explicit but unrecognized `revisionPolicy`, or a `pinnedRevision` present while `revisionPolicy !== 'pinned'` (or absent while it is), both reject the whole record via the existing `rejectInvalidScheduleRecord` path — including the case where `revisionPolicy` is absent entirely (the legacy-defaulting path above) but `pinnedRevision` is still present, since no writer in this codebase ever persists a pin without the policy that names it, so that combination is malformed, not legacy, and must not silently decode as `'active-at-fire'` and ignore the pin. No change to `WorkflowState`, checkpoint format, the durable task-ledger record version (`RemoteTaskBase.workflowRevision` is optional and additive, the same treatment `workflowExecutionToken` already has — `REMOTE_TASK_RECORD_VERSION` stays `1`), or the worker manifest schema (`WORKER_MANIFEST_VERSION` stays `1`). RemoteWorker protocol version stays `3` (`REMOTE_WORKER_PROTOCOL_VERSION` unchanged) — every new wire field is optional and additive in both directions.

- Per-run durable revision pinning and revision-grouped recovery (WFT-17/WFT-18). `WorkflowState` gains an optional `revision?: string` field, sibling to (never inside) `versionTuple`: the exact executable artifact a run started against — an eager registration's own loaded-code revision (`registeredCatalogRevisions`, NOT the catalog's cached active pointer, which can name a revision this process never loaded under a multi-engine deployment), or a dynamic source's resolved candidate revision — written once, atomically, in the same start batch `start.ts` already commits. `versionTuple` is completely unchanged and remains the sole semantic-compatibility axis recovery checks; `revision` answers "which artifact," never "may this resume." `WorkflowSummary` gains the matching optional `revision` field (`engine.list()`). Recovery's preflight now groups non-terminal state by structured `(type, revision)` — a nested `Map<type, Map<revision, …>>`, never a delimiter-joined key — and preloads/classifies every group before advancing any of that group's generators: **ready** (the pin resolves; an eager type is always ready regardless of pin, and a legacy pre-pinning record on a dynamic source with at most one registered candidate falls through to the prior active-pointer resolve unchanged), **unavailable** (the pin names a revision this process has not registered — including "it's the sole registered candidate, but a different one," closing a real bug where that fast path silently resolved against a stale mismatched candidate — or a legacy record on a dynamic source with two or more candidates, `reason: 'legacy-ambiguous'`; new error `WorkflowRevisionUnavailableError`, failed with `system` failure category, isolated to that group's own runs — sibling groups, including OTHER revisions of the SAME type, continue recovering normally), or **incompatible** (the existing, wholly unchanged `VersionMismatchError` mechanism). This closes the actual bug WFT-15/16's recovery preload barrier left open: a dynamic source with two or more registered revisions previously resolved every non-terminal run against whichever revision happened to be ACTIVE at recovery time, regardless of which one that run actually started on. A delayed-start (`startAt`/`startAfter`) timer fire is a third execution path that can launch a dynamic-source workflow outside both admission and `recoverAll()`'s batch — it now resolves against the pending run's own pinned `revision` too (`TimeOperationCallbacks.resolveExecutableRegistrationForRevision`, replacing the prior always-active-pointer `resolveExecutableRegistration`), closing the same class of gap for that path. New root-exported error `WorkflowRevisionUnavailableError` (`workflowType`, `revision`, `reason: 'not-registered' | 'legacy-ambiguous'`). `WorkflowRevisionReferenceCounts.nonTerminalRuns` (WFT-12) is wired to a real bounded storage scan instead of a permanent `0` — see the Changed entry below. `weft version:check`'s report and CLI output, and the `weft.catalog.diagnostics` reference breakdown, now show a per-revision count distinct from the semantic `workflowVersion`, since two revisions can share one version (a documentation-only redeploy, for example). `WorkflowTypeReport.revisionCounts` holds only real, persisted `revision` values — a dynamic source's revision is any non-empty, bounded string with no reserved values, so a legacy pre-pinning run (no persisted `revision`) is counted in a separate `unpinnedRunningCount` field rather than a sentinel key inside `revisionCounts`, which could otherwise collide with a genuinely pinned run using that literal string. See [Per-run revision pinning](documentation/guides/workflow-versioning.md#per-run-revision-pinning-wft-17) and [Dynamic-source recovery](documentation/guides/recovery-and-deploys.md#dynamic-source-recovery-durable-per-run-revision-pinning-wft-17wft-18).

- **Start admission fences on the resolved catalog entry under a lease ownership mode** (WFT-17, closing a cross-process race the coordinator's own planning notes flagged as an open question and Codex review on PR #958 confirmed): under `ownership: 'lease'` or `'workflow-lease'`, a fresh `engine.start()`'s create batch now carries an additional compare-and-swap precondition on the resolved revision's durable catalog entry (`catalog-entry:<name>:<revision>`) still matching the bytes this process read. `conditionalBatch`'s precondition is evaluated against live storage state at commit time, so this needs no coordination with `removeWorkflowRevision()`'s own CAS beyond both targeting the same key — whichever commit lands first wins, the loser fails closed. A start whose resolved revision is concurrently removed by another process before its own commit lands now throws `WorkflowRevisionUnavailableError` (`reason: 'not-installed'`) directly to the caller instead of silently committing a run pinned to a revision the catalog no longer carries; no `wf:` record is created for that attempt. Scoped to lease ownership modes only — `ownership: 'none'` is single-writer by contract, so the race cannot occur there, and its zero-precondition plain-`batch()` fast path is unchanged; both lease modes already require `conditionalBatch` for an ordinary start's own fencing, so this adds no new storage-capability requirement for the common path.

### Changed

- **`removeWorkflowRevision()` now correctly refuses a revision with a non-terminal run** (WFT-17): `WorkflowRevisionReferenceCounts.nonTerminalRuns`, previously always `0` (the WFT-12-flagged gap: "stays 0 until run-level revision pinning exists to count against"), is now a real, bounded `storage.scan('wf:')` count of non-terminal runs pinned to that exact revision — durable and cross-process, unlike the process-local `registeredDefinitions`/`inFlightStarts` fields. A revision a parked run still needs can no longer be silently removed out from under it. This is a behavior change to an already-shipped public function's (`removeWorkflowRevision`, WFT-12) observable refusal outcome, not just an additive field.
- **`removeWorkflowRevision()` re-checks references AFTER its durable delete, and restores the entry if a nonzero count turns up** (WFT-17, Codex review on PR #958): its own pre-check reference count is a snapshot — a concurrent `engine.start()` on a different process could read the entry as still installed and commit a run pinned to it in the narrow window between the pre-check and the delete landing. The post-check closes this: composed with the start-admission fencing above (any start whose own commit lands after the delete necessarily loses its own compare-and-swap), a nonzero post-delete reference count can only be a run that committed before the delete, so the function restores the entry and returns `'referenced'` rather than leaving a real run pinned to an uninstalled revision.
- **The catalog-entry delete and its own restore-or-finalize resolution are now each atomic, closing the crash window between them** (WFT-17/18, second-round Codex review on PR #958): `removeCatalogEntry`'s delete now lands in the SAME `conditionalBatch` as a new durable `catalog-tombstone:<name>:<revision>` record (the exact deleted bytes) — "the entry is gone" and "a durable record of what it was" commit together, atomically. `removeWorkflowRevision`'s post-delete restore-or-finalize is now itself a single atomic `conditionalBatch` against that tombstone (`restoreCatalogEntryFromTombstone` / `finalizeCatalogTombstone`), not a bare `install()`. A process crash between the two commits — previously an unrecoverable gap, closed only by documentation — now leaves a durable tombstone resolvable by ANY process, not just the crashed one: `catalog-tombstone-recovery.ts`'s boot-time sweep (`ensureWorkflowCatalogReady`, before recovery's own preflight or any new start observes catalog state) resolves every orphaned tombstone from a fresh durable reference count, and `removeWorkflowRevision` itself resolves a stale tombstone for its own exact `(name, revision)` target before proceeding, for a long-lived engine that observes a peer crash mid-lifetime.
- **A checkpoint-backed `retryFailedAll()` reactivation now fences its commit on the pinned revision's durable catalog entry, in every `ownershipMode`** (WFT-17/18, second-round Codex review on PR #958): a `failed` workflow is terminal, so it was never counted by `countWorkflowRevisionReferences`'s reference scan even while being actively reactivated — a `removeWorkflowRevision()` racing a retry's reactivation commit could report `removed: true` for a revision a run was concurrently being reactivated against, landing the reactivation `running` against a revision the catalog no longer carried. The reactivation batch now carries the same `conditionalBatch` precondition a fresh `start()` carries (`buildCatalogEntryRevisionCondition`), unconditionally — unlike `start()`, a retry has no `inFlightStartsByRevision` reservation of its own to close the same-process half of this race, so it needs the fence even under `ownership: 'none'`. A retry whose pinned revision is concurrently removed now throws `WorkflowRevisionUnavailableError` (`reason: 'not-installed'`), reported per-workflow in `retryFailedAll()`'s `errors`; the run stays `failed`, never left stranded `running`.
- **`fork()` now persists the forked child's `WorkflowState.revision`, inherited from the source run** (WFT-17/18, repository-owner review on PR #958): previously omitted entirely, which violated this batch's own "every fresh workflow record persists an exact revision" acceptance criterion for a forked run, and regressed recovery for a fork of a dynamic-source type with two or more registered candidates (recovery's `legacy-ambiguous` classification for a `revision === undefined` group on such a type would always fail a forked run's recovery). A fork continues execution against the same code the source run resolved, so `createForkedWorkflowState` now sets `revision: sourceState.revision` — the minimal change admission and recovery strictly need. `fork()`'s own commit still carries no catalog-entry precondition of its own (unlike `start()`/`retryFailedAll()` above); closing that narrow gap is left to WFT-21's fork/replay/purge scope, tracked there rather than fenced here.
- **A corrupted (present but malformed) decoded `WorkflowState.revision` is no longer silently downgraded to "absent"** (WFT-17, Codex review on PR #958): `decodeWorkflowState()` previously dropped a non-string, empty, or oversized `revision` to `undefined` — the SAME signal a genuinely pre-pinning legacy record carries, which recovery treats as unambiguous (and silently executes) for a dynamic source with at most one registered candidate. A malformed value is now replaced with a deterministic marker (`weft:corrupted-revision:<workflowId>`) instead — still a valid, bounded string, but one that cannot plausibly match any real registered candidate, so recovery rejects it explicitly via the ordinary `not-registered` `WorkflowRevisionUnavailableError` path rather than silently trusting a sole candidate against a checkpoint of unknown provenance.
- **A stale `registeredCatalogRevisions` cache entry is now invalidated synchronously on re-registration** (WFT-17, Codex review on PR #958): that map is populated only by the async catalog drain, once per pending install, so it could lag `internals.registrations` between a synchronous `register()` commit and the next drain completing. An internal start that bypasses the top-level `ensureWorkflowCatalogReady()` gate (`ctx.startChild()`, a scheduled occurrence firing mid-drain) reads this map synchronously; `register()`'s commit path now deletes any existing entry for the name immediately, so such a start correctly falls through to the async fallback resolver instead of risking a stale revision read. A no-op for the ordinary first-time-registration case; the only path that can legitimately change an eager registration's content under an unchanged name is the documented hand-rolled (non-builder) `WorkflowDefinition` escape hatch, since the ordinary `workflow().execute()` builder path throws on a same-name, different-content re-registration.

### Fixed

- **`engine.suspend()` no longer strands a same-engine `engine.resume()` behind a spurious `WorkflowClaimUnavailableError` under `ownership: 'workflow-lease'`** (WFT-134). `suspendWorkflow()`'s commit is classified an ADR-0002 "external terminal-ish transition": it durably rotates `wf-owner-epoch:<id>` and deletes `wf-owner-holder:<id>` via `buildWorkflowClaimExternalTerminalRotationTransition`, exactly like cancel/timeout/purge — but, unlike those, suspend is resumable, not terminal, and `suspendWorkflow()` never touched this engine's LOCAL `WorkflowClaimRegistry` cache, which kept reporting a non-null cached epoch for the workflow after the durable holder was already gone. A same-engine `resume()` then hit `acquireStandaloneClaimBeforeResume()`'s cached-epoch fast path, whose `wakeOwnershipCheck` re-read found the (correctly, just-deleted) holder absent and — before this fix — treated ANY discard reason as a hard failure, throwing `WorkflowClaimUnavailableError` immediately. The bug was timing-dependent: it self-healed once the next claim-renewal tick's CAS failed against the deleted holder and dropped the stale cache entry, which is why `suspend.test.ts`'s existing coverage (workflow state seeded directly into storage, with no in-memory claim ever tracked) never caught it. Two-part fix: `acquireStandaloneClaimBeforeResume()` (`core/engine/lifecycle/standalone-claim-acquire.ts`) now falls through to a fresh `registry.acquire()` specifically on discard reason `'holder-absent'`, instead of throwing — `'holder-undecodable'` and `'generation-mismatch'` remain hard failures, since both mean a real (foreign or corrupt) holder record is present; and `suspendWorkflow()` (`core/engine/termination/suspend.ts`) now epoch-guardedly forgets this engine's local cache entry immediately after its commit succeeds, via a new narrowly-scoped `WorkflowClaimRegistry.forgetLocalClaim()` (`core/engine/workflow-claim-registry.ts`, a LOCAL-only `Map` delete — no durable write, no CAS), closing the race deterministically rather than relying on the next renewal tick. The reclaim scan (`workflow-claim-reclaim-target.ts`/`workflow-claim-reclaim-scan.ts`) was audited and confirmed already correct: both its holder-keyed and running-status-keyed discovery scans, and its pre-drive `isWorkflowStillRunning*` eligibility gates, already exclude `'suspended'` workflows (a suspended run has neither a durable holder to discover nor a `running` status to pass the gate), so a suspended workflow's lapsed claim cannot be silently auto-resumed by the background reclaim sweep — no change was needed there.
- **Caller-facing workflow and task-operation ids can no longer be the exact string `.` or `..`, closing a URL-normalization quirk that made such an id permanently unaddressable over REST** (WFT-95). WHATWG URL path normalization collapses `.` and `..` path segments — and their percent-encoded forms — before `handleRequest()` ever sees `url.pathname`, so a REST route with a single trailing `:id`/`:operationId` segment (e.g. `/v1/workflows/:id`, `weft.tasks.get`'s `/v1/tasks/detail/:operationId`) could never address a resource whose id was literally `.` or `..`; no amount of percent-encoding rescued it, since the URL parser normalizes the encoded forms too, and this was unfixable inside `bindingPathMatches` (`src/server/rest-binding.ts`) because by the time it runs, `url.pathname` has already lost the information. Rather than leave this as a documented gap, `.`/`..` are now rejected at ADMISSION: `assertValidWorkflowId()` (`src/core/workflow-identifiers.ts`) rejects the exact strings `.` and `..` (an id merely containing a dot, e.g. `my.workflow.v2`, is unaffected) — this is the shared chokepoint `coerceStartWorkflowId()` calls, itself called from `start.ts`'s `prepareStartWorkflow()` for every caller-provided `options.id`, so `engine.start()`, `ctx.startChild()`, `engine.startOrSignal()`, and schedule creation are all covered by one fix. A new `isValidOperationId()` (`src/server/task-ledger-codec.ts`, re-exported from `task-ledger.ts`) applies the same `.`/`..` rejection to task `operationId`, enforced by `assertFreshDispatchOperationIdAdmissible()` (`src/server/runtime/task-dispatch-envelope.ts`), which `dispatchTaskImpl()` (`src/server/runtime/task-dispatch.ts`) calls at fresh-dispatch admission before a public `dispatchTask()` call ever reaches a ledger write — but is skipped when `dispatchTaskImpl` is redispatching an already-decoded, previously persisted ledger record (`scheduleDelayedDispatch()`/`taskDispatchFromLedgerRecord()`, covering startup recovery and expired-lease requeue), so a record from before this rejection landed keeps redispatching instead of being stranded. `buildCreateQueuedInput()` builds the durable envelope for both paths and does not perform this check itself — it still enforces the WFT-20 `workflowRevision` check. Both checks are admission-only, deliberately not added to any decode path (`decodeWorkflowState()`, `decodeRemoteTaskRecord()`, `decodeScheduleIdentityFields()`, `decodeScheduleRunMetadata()`) or to schedule/workflow lookup-and-control paths that address an already-persisted record by id (`coerceScheduleId()`, and `decodeWorkflowState()`'s `executionStateOwnerId`/`parentWorkflowId`/`restartedFrom.workflowId` lineage sanitizers, which now use the shared decode-facing `assertDecodableWorkflowId()` from `src/core/workflow-identifiers.ts`): an already-persisted record — however unlikely — must still decode, read back, and remain manageable correctly. Three internal REPLAY paths — not decode, not lookup — also needed the same relief: `drainQueuedScheduleRun()` (`src/core/engine/schedule-overlap.ts`) restarts a schedule's persisted `queuedRuns[].workflowId` through the ordinary `startWorkflow()` internal entry point, `retryFailedWorkflow()`'s checkpoint-absent fallback (`src/core/engine/bulk-operations-retry.ts`) rebuilds an already-persisted run from its stored input via `onTerminalConflict: 'start-new'`, and `dispatchChildWorkflowStart()`'s crash-reattach retry (`src/core/engine/child-workflow.ts`) replays `ctx.startChild()` to rediscover an already-persisted child via `WorkflowAlreadyExistsError`; all three could carry a legacy `.`/`..` id accepted before this rejection existed, and all three hit the same strict check `prepareStartWorkflow()` now applies to every caller-supplied `options.id`, stranding a pre-upgrade queued run, an already-persisted failed workflow, or a pre-upgrade parent's recovery. `startWorkflow()` (`src/core/engine/lifecycle/start.ts`) gains an internal-only `skipAdmissionIdCheck` parameter — never part of the public `StartOptions`/`StartWorkflowOptions` type, so no public surface (REST, JSON-RPC, `engine.start()`, `engine.startOrSignal()`, a fresh `ctx.startChild()`) can set it — that swaps the strict `coerceStartWorkflowId()` for the decode-compatible `coerceReplayWorkflowId()` when set. The schedule drain call always sets it to `true` (harmless: a queued run's `workflowId` was already validated at schedule-admission time, so relaxing the check here only matters for a historical pre-WFT-95 queued run). The bulk-retry and child-reattach call sites instead set it to the literal `'bulk-retry-only'`/`'reattach-only'` respectively, and both are fenced against the same TOCTOU race (chatgpt-codex-connector review, follow-up to the initial WFT-95 landing): each confirms an already-persisted record via a separate, non-atomic read before calling `startWorkflow()` — bulk retry via its own `loadWorkflowState()`, child-reattach via crash-reattach's confirmation read — but under `ownership: 'workflow-lease'`, another engine can purge that matched record in the window before `startWorkflow()`'s own atomic `resolveTerminalConflictForRestart()` re-reads it. `enforceReplayOnlyIdFence()` (`src/core/engine/lifecycle/start-terminal-conflict-purge.ts`, renamed from the reattach-only-scoped `enforceReattachOnlyIdFence()`) closes this for both: it applies only when that re-check still finds a terminal record to purge-and-replace or reattach to; if the race means the record is gone, `startWorkflow()` re-runs the strict `.`/`..` rejection at that point instead of silently creating a fresh reserved-id run, and a genuinely fresh `ctx.startChild({ id: '.' })` or `retryFailedAll()` call with no matching persisted record still gets the strict rejection on its one and only attempt. **This is a technically-breaking validation tightening**: a caller who explicitly chose `.` or `..` as a workflow or operation id (extremely unlikely in practice, since ids are effectively always UUIDs) will now have that start/dispatch rejected with a clear `StartWorkflowValidationError`/`Error` instead of silently succeeding into an id that could never be looked up again. The package is pre-1.0, so this ships as an ordinary fix rather than a major version bump.

- **Activity, finalizer, constraint, retention-deadline, and search-attribute-schema resolution for a dynamic-source workflow now uses the running instance's own pinned `WorkflowState.revision`, never whichever revision this process most recently resolved** (WFT-19, closing the known boundary WFT-17/18 left open). Before this release, `internals.activityRegistriesByWorkflow` mirrored EVERY resolved dynamic-source revision into one TYPE-keyed map, so the second of two revisions of the same type loaded in one process (two concurrent runs pinned to different revisions, or a redeploy with an old run still in flight) silently clobbered the first — every `ctx.run('activityName')` call from either running instance then resolved through whichever revision loaded last. Finalizer (`termination/finalizer-registration.ts`), constraint (`constraints.ts`), retention-deadline (`workflow-retention-deadline.ts`), and search-attribute-schema (`listing.ts`'s `setAttributes()`) resolution shared the same type-only, last-resolved-wins fallback (`getResolvedDynamicRegistration()`, previously 2-argument). All five now resolve through a new per-process, per-instance identity cache (`EngineInternals.workflowTypeByWorkflowId`, widened from `Map<string, string>` to `Map<string, { type, revision }>`), populated the moment a workflow begins executing — fresh start, delayed-start fire, resume, recovery, or an `ownership: 'workflow-lease'` reclaim redrive. `getResolvedDynamicRegistration()` and `resolveFinalizerRegistration()` both gained a REQUIRED (non-optional) third `revision` parameter, so a future type-only call site is a compile error rather than a silent gap; `scripts/check-revision-keyed-lookups.ts` (new, wired into `bun run lint` and the pre-commit hook) enforces that the two guarded fields this bug lived in are referenced only from their audited call sites going forward — matching on the bare field-name token (not just a leading-dot property access), so a destructured binding or a bracket-string access cannot evade the guard either (review round 2, Codex). The two fields' own declaring files (`internals.ts`, `source-runtime-state.ts`) are exempted by their EXACT declaration line, not the whole file, so an unrelated new reference added anywhere else in either file still fails the check (review round 3, Codex). See [Activity, finalizer, constraint, and retention routing follow the pin too](documentation/guides/workflow-versioning.md#activity-finalizer-constraint-and-retention-routing-follow-the-pin-too-wft-19).
- **`setAttributes()` and the retention-deadline calculation now await a full resolve for a registered-but-unresolved pinned revision instead of silently substituting a default** (WFT-19 review round 1, flagged by automated PR review). The Fixed entry above's sync-only `getResolvedDynamicRegistration()` returns `undefined` for a pinned revision this process has never locally resolved — even when it IS a registered candidate — which two call sites reachable OUTSIDE a running instance's own execution (a fresh engine's `setAttributes()` call, and its periodic retention sweep over a persisted terminal run) read as "nothing to resolve against," a real regression from the pre-WFT-19 last-resolved-wins fallback. `setAttributes()` now awaits `resolveExecutableRegistrationForRevision()` before validating, and REJECTS the mutation (`WorkflowRevisionUnavailableError`/`DynamicWorkflowSourceUnavailableError` propagate) rather than silently accepting unvalidated attributes — a new user-facing error surface for this specific case. `getWorkflowRetentionDeadline()` does the same, but — corrected in review round 2, since purge is irreversible — treats a resolve failure as "not purge-eligible this sweep" (`null` deadline) rather than falling back to the engine default: the run's own (unresolvable) policy could be LONGER than the default, so silently purging it under someone else's shorter policy was itself a regression, not a safe fallback. An unresolvable pin is simply re-examined on a later sweep once it becomes resolvable, never purged under a borrowed policy and never left permanently un-purgeable. Closing the retention-deadline call site also surfaced a deeper, related gap: the periodic sweep's `getMinimumRetentionMs()` scan-bound optimization only accounts for resolved policies, so it silently excluded any workflow pinned to a registered-but-unresolved revision from the scan entirely, regardless of the deadline fix — `streamExpiredRetentionWorkflowStates()` now falls back to an unbounded terminal scan (self-healing once the sweep's own resolve installs the candidate) whenever `hasUnresolvedDynamicSourceCandidate()` reports one exists, via a new `registration.ts` export.
- **A resumed or recovered workflow's per-instance identity cache was never populated on ANY resume/recovery path, until now** (WFT-19, a pre-existing latent gap surfaced and closed while wiring the fix above — independently reproducible and worth calling out on its own). `lifecycle/resume.ts`'s `relaunchInlineWorkflowAfterResume()`/`relaunchWorkerWorkflowAfterResume()` construct the generator/strategy launch directly, bypassing `lifecycle/start-exec.ts`'s `startWorkflowExecution()` — the only place that ever populated `workflowTypeByWorkflowId` before this release. A builder workflow's per-workflow `.activities({...})` step (dispatched by STRING name via `ctx.run('name')`, which attaches no `operation.fn`) recovered in a fresh process after a crash would fail activity resolution entirely for any activity not already replayed from a cached checkpoint result — both relaunch paths now populate the cache with the resumed instance's own exact `(type, revision)` before any possible activity dispatch.
- **`engine.fork()`'s checkpoint-launched run now also populates the per-instance identity cache (WFT-19 review round 2, Codex)**. The audit above enumerated every place a workflow begins executing from memory rather than mechanically, and missed one: `lifecycle/checkpoint-launch.ts`'s `launchWorkflowFromCheckpoint()` (the shared tail `fork()` drives) went straight to `inlineStrategy.adoptWorkflow()`/`strategy.startWorkflow()` without ever setting `workflowTypeByWorkflowId`, exactly the same gap resume/recovery had. A string-named scoped activity dispatched on a fork's live frontier could resolve through the global registry (or fail) instead of the fork's own pin, and constraint evaluation could silently fall back to whichever sibling revision this process most recently resolved. Fixed the same way: the identity is set before either checkpoint-launch strategy can drive the generator's first turn.
- **The resume/recovery and fork identity-cache writes above now cache the resolver's own resolved revision, not the run's raw persisted pin (WFT-19 review round 5, Codex, P1)**. A legacy (pre-revision-pinning) record on a dynamic-source type with exactly one registered candidate has `state.revision === undefined`, yet `resolveExecutableRegistrationForRevision()` deliberately resolves that sole candidate anyway (the "legacy, unambiguous" fast path) and builds `registration` from it. The two `resume.ts` relaunch paths and `transition.ts`'s `fork()` were caching the raw `undefined` pin instead of that resolved revision, so `resolveActivityViaRegistries()`'s exact-`(type, revision)` branch never fired for such a run — a per-workflow `ctx.run('name')` activity fell through to the eager/global-only registry (empty for a dynamic-source type since the mirror-write removal above) and either hit a same-named global activity or threw `ActivityResolutionError`. All three call sites now thread the resolver's own returned revision through (`SerializedResumeArgs.resolvedRevision`, `fork()`'s destructured `revision`) instead of re-reading `state.revision`/`latestState.revision`/`forkState.revision` independently.
- **`getResolvedDynamicRegistration()`'s sync-only fallback for an absent per-instance pin now fails closed with 2+ registered candidates, instead of silently substituting whichever revision this process last resolved (WFT-19 review round 6, Codex, P1)**. `revision === undefined` previously always fell back to `lastResolvedRevisionByName` — correct for the type's sole registered candidate (the "legacy, unambiguous" case), but genuinely ambiguous with two or more, since there is no way to tell which candidate a legacy record actually started against. This buggy fallback let `workflow-retention-deadline.ts` purge a legacy record early under a sibling's shorter retention window (irreversible), let `termination/finalizer-registration.ts` run a sibling's finalizer, and let `listing.ts`'s `setAttributes()` validate against a sibling's schema — all bypassing the `legacy-ambiguous` classification the async resolver would otherwise correctly reach. The sync fallback now gates on `canResolveRevisionLocally()`, returning `undefined` (forcing the async fallback, which fails closed) whenever 2+ candidates are registered. `retention.ts`'s `resolveWorkflowTypeRetention()` — a genuinely TYPE-level overview API with no single instance to pin against — keeps the permissive last-resolved-wins answer via a new, explicit `resolveLastKnownDynamicRegistration()` export instead.
- **A fork of a legacy (revision-undefined) source run now persists its own resolved revision durably, not `undefined` (WFT-19 review round 6, Codex, P1)**. `createForkedWorkflowState()` stamped the fork's own persisted `revision` field with `sourceState.revision` alone — `undefined` for a legacy source — even though `fork()`'s resolver had already resolved (and launched the fork against) the type's sole registered candidate. The fork ran correctly until the next process restart, but a fresh-process `recoverAll()` after a second candidate was later registered would classify the durably-unpinned fork `legacy-ambiguous` and refuse to resume it, even though its own resolver knew exactly which revision it belonged to at creation time. `createForkedWorkflowState()` now stamps `sourceState.revision ?? resolvedRevision` — the resolver's resolved value fills in ONLY when the source's own persisted revision is itself `undefined`, mirroring the review-round-5 fix already applied to the in-memory identity cache. (Stamping the resolver's answer unconditionally, tried first, regressed every EAGER-type fork's persisted `revision` — `resolveExecutableRegistrationForRevision()` always returns `revision: undefined` for an eager registration, distinct from the real value `resolveCachedStartRevision()`'s `registeredCatalogRevisions` fallback stamps on `WorkflowState.revision` at ordinary start time; caught by `tests/replay-fixtures/fork-from-checkpoint.json`'s golden byte comparison before merge.)
- **A delayed-start ("timer fires, run begins executing") launch now threads the resolver's own resolved revision into `beginWorkflowExecution` and the persisted running state, instead of a raw re-read that could be `undefined` (WFT-19 review round 7, chatgpt-codex-connector + stevekinney, P1)**. The exact same class of bug review round 5 fixed for `resume.ts`'s two relaunch paths and `transition.ts`'s `fork()` was missed on this fourth launch path: for a legacy (pre-revision-pinning) `pending` record on a dynamic-source type with exactly one registered candidate, `resolveDelayedStartRegistrationOrFail()` unambiguously resolves that candidate but `operations-time.ts`'s `startDelayedWorkflow()` was passing the still-`undefined` `runningState.revision` into `beginWorkflowExecution` — mis-stamping the per-instance identity cache, so the run's first-turn per-workflow `ctx.run('name')` activity call either fell through to a same-named global activity or threw `ActivityResolutionError`. `resolveDelayedStartRegistrationOrFail()` now returns the full `{ entry, revision }` pair (mirroring `resolveExecutableRegistrationOrRenamedNotFound()`'s shape) and the pending→running transition stamps `latestState.revision ?? resolvedRevision` onto the newly persisted running state — never the resolver's answer unconditionally, which would wipe an EAGER type's real pin (`resolveExecutableRegistrationForRevision()` always returns `revision: undefined` for an eager registration; same eager-vs-legacy distinction review round 6's fork fix already had to account for).
- **`resumeWorkflowFromStorage()` now re-validates a resuming run's generation (`type`/`revision`/`workflowExecutionToken`) immediately before its serialized commit, not just its `status` (WFT-19 review round 7, chatgpt-codex-connector + stevekinney, P1)**. `performSerializedResume()`'s serialized section re-reads workflow state fresh but previously only re-checked `status`; an `onTerminalConflict: 'start-new'` replacement landing at the SAME workflow id between the top-of-function state read (which built `registration`/`resumeCheckpoint`) and that fresh re-read — e.g. a concurrent cancel/timeout terminalizes the run, then a fresh `start()` call replaces it — purges the old record and writes a brand-new one with a fresh `workflowExecutionToken` (minted by every `start()`), possibly a different `type`/`revision` too. A DIFFERENT engine's replacement was already caught by `acquireStandaloneClaimBeforeResume`'s durable `wakeOwnershipCheck` (workflow-lease mode only, and only holder identity, never workflow identity); a SAME-engine replacement's fold-acquire updates this engine's own already-held claim in place, leaving that check trivially satisfied. Without this fix the stale `registration`/checkpoint would replay against the replacement's fresh state. New `core/engine/lifecycle/resume-generation-guard.ts` (`assertSameGeneration`, `deriveResumeGeneration`) carries the check and its fix rationale to stay under the 500-line implementation-file ceiling.
- **`engine.fork()` now resolves its handler against the SOURCE run's own pinned revision, never the catalog's currently active pointer** (found while proving the identity-cache fix above — a genuinely more severe sibling of it). `lifecycle/transition.ts`'s `fork()` resolved via `resolveExecutableRegistration` (the active-pointer resolver) instead of `resolveExecutableRegistrationForRevision(type, sourceState.revision)`: if the catalog's active pointer had moved to a different revision between the source run starting and the fork call (a routine redeploy, or another engine's `engine.workflows.activate()`), the forked run launched against a DIFFERENT REVISION'S HANDLER ENTIRELY — not a downstream routing mismatch, but the wrong workflow code running from the fork's very first turn, silently. Mirrors the identical, already-shipped fix in `resolveExecutableRegistrationForRetry()` for bulk retry. `dynamic-source-execution.test.ts`'s new fork identity-cache test caught this directly: before this fix, the forked run's result was the SIBLING revision's entire return value.
- **`ownership: 'workflow-lease'` reclaim eligibility now recognizes a registered-but-unresolved dynamic source, and checks the stranded run's own pinned revision, instead of only eagerly-registered types** (WFT-19, ADR-0002). `isWorkflowTypeRegistered` previously checked only `internals.workflowDefinitionsByName` (eager registrations); a fleet member that `registerSource()`-registered but had not yet resolved a dynamic-source type — or had resolved a DIFFERENT revision than the one a stranded run was pinned to — was never eligible to reclaim that run's claim, permanently stranding it. The check is now `(workflowType, revision) => canResolveRevisionLocally(internals, workflowType, revision)`, the same predicate execution-time revision resolution uses, so the two decisions cannot disagree. See [0002-multiengine-per-workflow-ownership.md](documentation/contributing/architecture-decisions/0002-multiengine-per-workflow-ownership.md).
- **The reclaim-eligibility check above is now revalidated AFTER the takeover/acquire CAS lands, not just before it (WFT-19 review round 4, Codex)**. `isEligibleForFreshTakeover` reads the candidate's `(type, revision)` and the `registry.takeover()`/`registry.acquire()` CAS are two separate storage operations; an `onTerminalConflict: 'start-new'` replacement landing in that window can swap the SAME workflow id onto a DIFFERENT revision this engine is not actually eligible for — the CAS fences only the holder/epoch keys, never workflow identity, so it lands regardless. `workflow-claim-reclaim-target.ts`'s existing post-acquire `confirmStillRunningOrReleaseFreshClaim` (which already re-checked running-status for the identical class of race) now also re-checks eligibility via one combined fresh read (`isWorkflowStillRunningAndEligible`), releasing the claim instead of driving it when either check fails. Without this, an engine eligible only for the old revision could durably hold the claim for the new one; since a failed `onReclaimed` drive is retried in place, never released, the workflow would be permanently stranded away from any engine that could actually run it.
- **`Engine#getWorkflowActivityDefinition()`/`Engine#listWorkflowActivityDefinitions()`'s per-workflow lookup is now correctly eager-only for a `registerSource()`-registered type, resolved or not** (WFT-19; wording corrected in review round 2, Codex), instead of possibly reflecting a stale or mismatched revision's activity metadata — a side effect of the mirror-write removal above, and a deliberate narrowing to eager-only scope for these two synchronous, type-only accessors, which have no running instance to resolve a specific revision against. This does not mean both always return `undefined`/`[]` for such a type: `getWorkflowActivityDefinition()` still falls back to the global activity registry when the per-workflow lookup misses, so a same-named global activity is still returned; only `listWorkflowActivityDefinitions()`, which has no such fallback, returns `[]` unconditionally for a dynamic-source type. Documented as a `Fixed` behavior narrowing, not a breaking change: these accessors never had defined multi-revision semantics to begin with. See [`getWorkflowActivityDefinition()`](documentation/reference/api-engine.md#getworkflowactivitydefinition).
- Two separate `Engine` instances started concurrently against one shared store with the same explicit `id` and no `idempotencyKey` no longer leave the losing caller hanging (WFT-152). Both starts previously committed blind: `persistStartBatch` took its unconditioned path, the second engine's create record overwrote the first's, and both engines launched a generator for the same id. Only one of them then reached `notifyCompletionWaiters()` — the other found the workflow already non-`running` in `completeWorkflow()` and returned early — so the loser's `handle.result()` never settled. Under `ownership: 'none'` there is no claim registry, so the cross-engine result poll that rescues this case under `ownership: 'workflow-lease'` never runs.

  The chosen behaviour is **fail fast**, not resolve-to-winner: with no `idempotencyKey` the caller has expressed no intent to share a run, and a duplicate explicit id is already an error everywhere else. A start with a caller-supplied `id` now carries a compare-and-swap precondition on the workflow record as its duplicate-id check observed it (`null` when absent, or the prior terminal run's exact bytes for an `onTerminalConflict: 'start-new'` restart), committed atomically with the create batch. The loser rejects with `WorkflowAlreadyExistsError` — the same error the in-engine `pendingStarts` guard already raises for the identical collision, so a cross-engine duplicate id is indistinguishable from an in-engine one at the call site. This does not make `ownership: 'none'` safe for multiple engines; recovery, timers, and signal delivery remain uncoordinated. See [Recovery and Deploys](documentation/guides/recovery-and-deploys.md#one-engine-per-durable-store).

  A lost duplicate-id compare-and-swap is attributed by elimination, never by re-reading the workflow record: the winning run can complete and be purged (or swept by retention) before any re-read, restoring the record to exactly the value the condition expected, so the conflict reads back as "no conflict". Where the workflow also declares `concurrency`, the start retries admission only on positive evidence that the concurrency condition is what missed, and otherwise fails closed with `WorkflowAlreadyExistsError`. That evidence is not treated as proof the id was free — the concurrency precondition is a monotonic atomic-state version key, so it stays mismatched once a same-id winner has acquired and released. What makes the retry safe is the positive duplicate-id re-check that runs first: reaching the retry means the workflow record still matches, so the id is free and the retry re-conditions on that same value.

  Starts with a generated id are unchanged and stay on the unconditioned single-write hot path, since a v4 UUID cannot collide. Explicit-id starts now commit through `conditionalBatch`; every engine already requires that capability for workflow catalog activation at `Engine.create()`, so no backend loses support.

### Persisted-data compatibility

- `WorkflowState.revision` is purely additive with no legacy value to lift or reconstruct (unlike `versionTuple`, which lifts from prior flat fields). `CURRENT_PERSISTED_DATA_SCHEMA_VERSION` is **not bumped** (stays `2`): a pre-this-release record simply decodes with `revision: undefined`, which recovery treats as an unambiguous, harmless legacy case for the overwhelmingly common paths (every eager type; every single-candidate dynamic source) and as a bounded, explicitly-classified `unavailable` outcome only for the genuinely ambiguous case (a dynamic source with two or more registered candidates and no pin to disambiguate). This follows the WFT-9/WFT-10 precedent (new, purely additive key prefixes, no bump) and the semantic-compatibility skill's decode-lift/tolerate-and-strip contract for `WorkflowState` version metadata, rather than the 0.23.0 precedent (a boot-time schema-version gate), because a schema bump here would reject an entire store for a purely additive field and could not express the actual interesting behavior (a legacy record's outcome varies per-run, at recovery time — not at boot). `tests/replay-fixtures/*.json` and `tests/checkpoint-compat/*.bin` were regenerated TWICE this PR: once for the original `revision` field, and again for `fork()` now populating it on a forked child's record — both times verified with a line-by-line diff confirming no other field, key, or ordering changed beyond the intended addition; both fixture test files' header comments gained a second, narrower exception clause covering this case. Read-side only, no schema change: a present-but-malformed decoded `revision` now normalizes to a deterministic corruption marker string instead of `undefined` (see the Changed entry above) — still `WorkflowState.revision?: string`, no new field, no persisted-shape change.
- **New additive, transient key prefix: `catalog-tombstone:<name>:<revision>`** (WFT-17/18, second-round Codex review on PR #958). `CURRENT_PERSISTED_DATA_SCHEMA_VERSION` is **not bumped** (stays `2`): this key carries no new encoding — its value is byte-identical to the `catalog-entry:<name>:<revision>` record it stands in for while a removal is being atomically resolved (restored or finalized) — and it is transient by design (present only in the brief window between `removeCatalogEntry`'s delete commit and its own resolution, normally sub-millisecond; an "orphaned" tombstone left behind by a crash is swept and resolved at the next `ensureWorkflowCatalogReady()` boot). A durable store with zero in-flight or crashed removals at upgrade time has zero `catalog-tombstone:` keys; an older `@lostgradient/weft` version reading a store written by this release would simply never look for this prefix and would not observe it, same as any other purely additive key prefix (the WFT-9/WFT-10 precedent). Added to `WEFT_RESERVED_KEY_PREFIXES` (`src/storage/key-prefixes.ts`).
- **WFT-19 is entirely process-local, in-memory routing — no persisted-data shape changed.** Every fix in the Fixed section above reads the already-persisted `WorkflowState.revision` field WFT-17 introduced; none of it writes a new key prefix, changes a codec, or reshapes a checkpoint or catalog record. `CURRENT_PERSISTED_DATA_SCHEMA_VERSION` stays `2`. No `BREAKING-CHANGES.md` entry.

## [0.24.0] - 2026-09-09

### Added

- `LMDBStorage` accepts a `durability` construction option (WFT-138), `'full' | 'relaxed'`, defaulting to `'full'`. `'relaxed'` opens the LMDB environment with `noSync: true` and `noMetaSync: true`, skipping `fsync` on every commit to reduce write latency under host I/O contention—intended for test fixtures and other disposable environments, not for storage backing recoverable production workflows. `LMDBStorageConfiguration` (`resolveStorage`) and the underlying `LMDBStorage` constructor accept the same field; construction rejects any other value. A relaxed-durability instance reports `capabilities().persistence` as `'ephemeral'` instead of `'local'`, so `assertDurableStorageForRecovery()` correctly rejects it as unsafe for crash recovery.
- `Mailbox` (WFT-84), a durable application command mailbox: a storage-backed, strictly FIFO command queue scoped to an opaque `(namespace, resourceId)` pair, with idempotent admission bound to `(caller, target, kind, payloadDigest)`, attempt-fenced claims and renewal under an absolute per-command deadline, cancellation that is durable before it reaches any claimant and reports honestly whether cleanup is still pending, bounded backlog and listing, an explicit maintenance pass (no hidden timers), and state transitions that commit atomically with their fleet events when a `FleetEventFeed` is supplied. Requires storage with `conditionalBatch`, snapshot scans, and linearizable read-after-write. New public errors `ApplicationCommandValidationError`, `MailboxContentionError`, and `WaitBudgetElapsedError`; reserved key prefixes `appmbx:`, `appcmd:`, `appready:`, `appseq:`, `appidem:`, `appterm:`, `appprobe:`. See the [Mailbox](documentation/guides/mailbox.md) guide.
- `Outbox` (WFT-85), a durable application delivery outbox: the outbound sibling of the mailbox, scoped to `(namespace, ownerId)`, delivering through a caller-supplied `ApplicationDeliveryAdapter`. Every attempt is durably marked `attempting` before `send()` is called, so a lease that lapses before the send is a safe retry and one that lapses after it is an unknown outcome governed by an explicit `unknownOutcomePolicy` (`park`, `dead-letter`, or `retry-with-idempotency`, the last accepted only with an `externalIdempotencyKey`). Attempts carry a renewable visibility window plus a fixed per-attempt deadline, and the runner renews the lease while the adapter runs; the due index is time-keyed rather than FIFO; cancellation is durable and an acknowledgement that lands afterwards still wins; operators `retry()` or `deadLetter()` parked deliveries; `drain()` reports counts only, and only what it committed. `credentialRef` reaches only the adapter. Requires storage with `conditionalBatch`, snapshot scans, and linearizable read-after-write, so `TursoStorage`, `HttpStorage`, and `IndexedDBStorage` are rejected at construction. New public errors `ApplicationDeliveryValidationError` and `OutboxContentionError`; reserved key prefixes `appobx:`, `appdlv:`, `appdue:`, `appdseq:`, `appdidem:`, `appdterm:`. See the [Outbox](documentation/guides/outbox.md) guide.
- `WorkflowContract`, `contractHash()`, and `WorkflowRevisionManifest` as the canonical normalized-contract vocabulary (WFT-5): `buildWorkflowContract()` converts an authoring-time workflow definition to the same normalized representation `weft codegen` emits types from; `normalizeWorkflowContract()`/`canonicalWorkflowContractJson()` make that representation deterministic regardless of source key order; `contractHash()`/`activityContractHash()` compute a payload-only content identity (excludes `name`/`workflowVersion`/`description`/`tags`); `deriveWorkflowRevision()` computes the broader full-identity `revision`; `buildWorkflowRevisionManifest()`/`parseWorkflowRevisionManifest()` build and validate the typed `WorkflowRevisionManifest` from trusted or untrusted (`unknown`) input, respectively — the parser always recomputes and compares `contractHash`, rejecting a mismatch. See the [Revision Identity](documentation/guides/workflow-versioning.md#revision-identity) guide.
- `checkWorkflowCompatibility()` (WFT-8), the structured compatibility comparison behind automatic activation: given two `WorkflowRevisionManifest` values, it returns a `WorkflowCompatibilityVerdict` (`{ compatible: true }` or `{ compatible: false, reasons }`) naming every applicable `WorkflowCompatibilityReason`—`name-mismatch`, `manifest-version-unsupported`, `contract-hash-mismatch`, `workflow-version-incompatible`, `artifact-revision-mismatch`—in that fixed order, never just the first one found. `workflow-version-incompatible` reuses `checkVersionCompatibility()` (`core/versioning.ts`) directly, so its answer can never disagree with what recovery already enforces. The one tunable axis, `WorkflowCompatibilityPolicy.requireExactRevision` (default `true`, see `DEFAULT_WORKFLOW_COMPATIBILITY_POLICY`, frozen), controls only whether a `revision`-only difference blocks compatibility—under the default content-derived revision that means `contract.description`/`contract.tags` edits, but under a caller-supplied revision it means any artifact-identity change the caller encoded there, so `requireExactRevision: false` should not be set for manifests using explicit revisions unless that broader tolerance is intended—the other four reasons can never be loosened by policy, which is what lets a refresh system report every reason without being able to override one during automatic activation. Pure, synchronous, and symmetric. The internal workflow catalog (WFT-9/WFT-10, below) now wires this in on its guarded activation primitive. See the [Activation Compatibility](documentation/guides/workflow-versioning.md#activation-compatibility) guide.
- Internal durable workflow catalog (WFT-9/WFT-10): `engine.register()` remains the only producer — install and unconditionally activate on first install; a byte-identical re-registration is a no-op; conflicting metadata under an existing `(name, revision)` key throws. Entries and each name's active pointer (`{ revision, generation }`) persist through `conditionalBatch` compare-and-swap, restored from durable storage before recovery or any new start on every boot, so a restart resolves the same active revision and generation. Two new reserved storage key prefixes: `catalog-entry:` (one immutable record per installed revision) and `catalog-active:` (one mutable pointer per workflow name) — both purely additive; **`CURRENT_PERSISTED_DATA_SCHEMA_VERSION` is not bumped** (stays `2`), since no prior Weft version ever wrote these prefixes, so there is nothing for an older or newer reader to misinterpret. `RegistrySnapshot.activeRevisions` now reads from the catalog instead of being recomputed from each freshly-built manifest. `register()` itself still returns synchronously — the actual durable install/activation is deferred to the next `await` boundary inside the engine (`Engine.create()`, `start()`, `recoverAll()`, and similar), which means a `RegistryManifestLimitError` from an oversized contract can now surface at one of those call sites instead of only at snapshot/codegen time. See [Revisions and the Catalog](documentation/guides/workflow-versioning.md#revisions-and-the-catalog) and [`register()`](documentation/reference/api-engine.md#register).
- **`engine.workflows`** (WFT-11) promotes the internal workflow catalog above to a public, admin-facing surface: `install(manifest)`, `activate(name, revision, options?)`, `getActive(name)`, `getRevision(name, revision)`, and `listRevisions(name)`, plus five matching REST + JSON-RPC operations under `/v1/registry/` (`weft.workflows.revisions.install`/`.activate`/`.get`/`.list`, `weft.workflows.active.get`; `install`/`activate` require `workflows:admin`, the three reads require `workflows:read`). This is catalog bookkeeping and promotion control only — it never changes which in-process handler `engine.start()` dispatches to, only what `RegistrySnapshot.activeRevisions` reports. `install()` requires `getWorkflowDefinition(manifest.name)` to already resolve in-process; module loading is a later batch's job. New public types `WorkflowRevisionRecord`, `ActivateWorkflowRevisionOptions`, and a new `applied: false` `WorkflowCatalogActivationResult` variant (`reason: 'expected-generation-required'`); `WorkflowCatalogActivePointer`, `WorkflowCatalogActivationResult`, and `WorkflowCatalogConflictError` are now root-exported (previously package-internal); new public error `WorkflowRevisionNotInstalledError`. The `Conflict` operation fault gains two optional fields, `currentGeneration` and `compatibilityReasons`, exposed over both REST and JSON-RPC — only the internal `reason` string stays REST-withheld, matching REST's existing deny-by-default boundary for that field. No persisted-data schema change: no new storage keys, no change to the wire-record formats `engine.register()` already writes; this batch only adds read paths and tightens an in-process validation rule (below) on an existing write path. See [`engine.workflows`: public catalog control](documentation/guides/workflow-versioning.md#engineworkflows-public-catalog-control) and [`api-server.md`](documentation/reference/api-server.md#workflow-catalog).
- Dynamic workflow source primitive, loader, and validation (WFT-13/WFT-14): `workflowSource(descriptor, loader)` builds a typed `WorkflowSourceHandle` pairing plain, serializable `WorkflowSourceDescriptor` metadata (`kind`, `name`, `location`, `exportName`, `revision`, optional pinned `workflowVersion`/`contractHash`) with a host-side loader capability (`() => Promise<unknown>`) that is **never serialized**; a literal `() => import('./x.ts')` loader preserves the loaded definition's exact `TInput`/`TOutput`/`TName`/`TServices` inference through to the returned handle, while a dynamic `import(pathVariable)` (typed `Promise<any>`) is rejected at the `workflowSource()` call site itself. `engine.registerSource(source)` is a new synchronous `Engine` method — like `register()`, it never touches storage and, additionally, never invokes the loader; it only records a catalog candidate keyed `(name, revision)`. A workflow name may not be both eagerly registered and a dynamic source — `register()` and `registerSource()` now refuse each other's names symmetrically. `engine.resolveWorkflowSource(name, revision, options?)` is a new async `Engine` method that loads, validates from `unknown`, and installs the revision into the existing WFT-9/10 durable catalog via `WorkflowCatalog.install()` — single-flight per `(name, revision)` (concurrent callers share one loader invocation; each caller's own cancellation via `options.signal` or engine disposal rejects only that caller, never a load other callers still need) and a no-op re-evaluation for an already-installed revision. Validation rejects a missing or ambiguous export, the removed bare-handler shape, an oversized contract, and a `name`/`revision`/`workflowVersion`/`contractHash` mismatch against the descriptor's expectations (reusing `checkWorkflowCompatibility()` from WFT-8) as a bounded `WorkflowSourceRejectionReason[]` on the new `WorkflowSourceValidationError`. A workflow registered both eagerly and lazily from logically identical content now always produces a byte-identical manifest either way — `registry-workflow-manifest.ts`'s contract-building was refactored (`buildWorkflowManifestFromDefinition`, `buildWorkflowScopedActivityContracts`) so both paths share the same normalization instead of risking two independently-derived contracts. **Does not wire `engine.start()` or recovery to await resolution** — that is WFT-15's job — and adds no diagnostics or events (WFT-16). No persisted-data schema change: `resolveWorkflowSource()`'s successful path writes only through the already-reserved `catalog-entry:` key prefix WFT-9/10 established (via `WorkflowCatalog.install()`) — it never writes or changes a name's `catalog-active:` pointer, so a resolved revision is installed but not thereby made active; `WorkflowSourceDescriptor`/`WorkflowSourceHandle` are pure in-memory values (the loader is a closure and cannot be serialized) and are never persisted. New public exports: `workflowSource`, `WorkflowSourceDescriptor`, `WorkflowSourceDescriptorInput`, `WorkflowSourceHandle`, `WorkflowSourceKind`, `WorkflowSourceRejectionReason`, `WorkflowSourceValidationError`, `Engine.registerSource()`, `Engine.resolveWorkflowSource()`. See [Dynamic Workflow Sources](documentation/guides/workflow-versioning.md#dynamic-workflow-sources).
- Engine integration, diagnostics, and disposal for dynamic workflow sources (WFT-15/WFT-16), the final slice of the Dynamic Loading project. Every execution entry point that can launch or resume a workflow — `engine.start()`, `startOrSignal()`, `schedule()`, `fork()`, `resume()`, `recoverAll()` (and therefore `Engine.create()`, which calls it by default), and bulk-retry — now awaits dynamic-source resolution through one shared internal helper (`resolveExecutableRegistration()`) for a `registerSource()`-registered type before running any handler code; an eagerly `engine.register()`-ed type still resolves synchronously and never touches the dynamic-source machinery — starting an eager workflow never imports a differently-named lazy source. A lazy name with two or more registered revisions and no catalog active pointer naming one of them throws the new `DynamicWorkflowSourceUnavailableError` (`reason: 'ambiguous-revision'`) rather than guessing; the same error (`reason: 'load-failed'`) wraps a load failure at any of those entry points. `engine.workflows.preload(name, revision, options?)` is a new, documented thin alias for `resolveWorkflowSource()` on the `workflows` namespace, plus a matching `weft.workflows.revisions.preload` REST (`POST /v1/registry/workflows/:name/preload`) + JSON-RPC operation (`workflows:admin`, non-destructive, faults `NotFound`/`Conflict`). `weft.catalog.diagnostics` (and the in-process `getWorkflowRevisionDiagnostics()`) gains an optional `source` field — kind, requested revision, load state (`'idle' | 'loading' | 'ready' | 'failed' | 'cancelled'`), load duration, last failure category, and outstanding waiter count — present only when the name was ever `registerSource()`-registered; the `Conflict` operation fault gains a new `sourceValidationReasons` field (REST + JSON-RPC) for a loaded module that fails validation, following the existing `compatibilityReasons` precedent. Four new bounded, process-local events fire around the load pipeline: `workflow-source:load-started`, `-ready`, `-failed`, `-cancelled` — the last fires exactly once, only when the LAST outstanding waiter for a `(name, revision)` releases while the shared load is still unsettled (the shared load itself is never aborted — only per-caller waiter interest is; a cancelled `resolveWorkflowSource({ signal })` waiter never aborts a load a concurrent `start()` still needs). Engine disposal settles every pending waiter with `EngineDisposedError` and closes resolver resources. Recovery preloads every DISTINCT dynamic-source type referenced by non-terminal state ONCE, before advancing any of those runs' generators — a batch-wide barrier; a type whose load fails is classified `unavailable` (only its own runs fail, `system` failure category, `DynamicWorkflowSourceUnavailableError` as the cause) while sibling types continue recovering, mirroring the existing version-mismatch isolation. **This is a feature gate, not durable per-run revision pinning** — which revision an in-flight run resolves against during recovery is derived at runtime from the catalog's active pointer plus whichever `registerSource()` calls this process happens to have made, never persisted per-run; the same last-resolved-revision-wins rule applies to a dynamic type's activity registry, keyed by `type` alone rather than `(type, revision)` — see [the recovery guide](documentation/guides/recovery-and-deploys.md#dynamic-source-recovery-durable-per-run-revision-pinning-wft-17wft-18). `engine.registerSource()` now throws under `workflowExecutionMode: 'worker'` — a dynamically-loaded definition resolves into this process's in-memory engine internals, which only the inline execution strategy reads directly; use inline mode (the default) or `engine.register()` instead. Also fixes a correctness bug in the already-merged `resolveWorkflowSource()` cache-hit fast path (WFT-13/14): it skipped populating the local resolved-definition cache, which would have broken cross-process-restart recovery — a second process's `registerSource()` + recovery now correctly falls through to a real load (once) when the local cache is empty even though the catalog already has the manifest installed, since `WorkflowCatalog.install()` is idempotent on byte-identical content. No persisted-data schema change: every new field lives on process-memory-only engine internals or the new in-memory diagnostics/state maps; no `WorkflowState`, `Checkpoint`, or catalog-entry shape changes — see [the recovery guide](documentation/guides/recovery-and-deploys.md#dynamic-source-recovery-durable-per-run-revision-pinning-wft-17wft-18) for the explicit non-pinning caveat this implies. New public exports: `WorkflowSourceNotRegisteredError`, `DynamicWorkflowSourceUnavailableError`, `WorkflowSourceLoadStartedEvent`, `WorkflowSourceLoadReadyEvent`, `WorkflowSourceLoadFailedEvent`, `WorkflowSourceLoadCancelledEvent`. See [Engine Integration (WFT-15/16)](documentation/guides/workflow-versioning.md#engine-integration-wft-1516), [Dynamic Workflow Source Events](documentation/reference/api-events.md#dynamic-workflow-source-events), and [the diagnostics endpoint](documentation/reference/api-observability.md#get-v1catalognamerevisionsrevisiondiagnostics).
- Reference accounting, removal, catalog events, and `weft.catalog.diagnostics` (WFT-12), the final slice of the versioned-workflow-catalog project. `WorkflowRevisionReferenceCounts` is a 7-field accounting interface, keyed by structured `(name, revision)`: `registeredDefinitions` and `inFlightStarts` are wired to real in-process signals now; `nonTerminalRuns`, `pinnedSchedules`, `pendingDispatches`, `activeExecutionRealms`, and `retainedRecoveryRecords` stay structurally present but always `0` until run-level revision pinning (WFT-17) exists to count against. The new root-exported `removeWorkflowRevision(engine, name, revision)` durably removes an installed, non-active, unreferenced revision—refusing with `'active'` (a structural invariant, checked before any reference count) or `'referenced'` (carrying the full count breakdown) otherwise, and `'not-found'`/`'conflict'` for the remaining outcomes—via a `conditionalBatch` CAS fenced on both the exact entry bytes AND the exact active-pointer bytes read, so a concurrent activation racing the delete loses to `'conflict'` rather than silently landing. `getWorkflowRevisionDiagnostics(engine, name, revision)` projects the same accounting read-only, including a derived `removable` boolean. Five new bounded `WeftEventMap` events fire from the existing register()-drain path, a new guarded-candidate-activation wrapper, and the removal orchestrator: `catalog:revision-installed`, `catalog:revision-activated`, `catalog:activation-rejected`, `catalog:revision-draining`, `catalog:revision-removed`—every payload is primitives/bounded arrays, never a full manifest or `WorkflowCompatibilityVerdict`. One new read-only, `system:read`-scoped operation, `weft.catalog.diagnostics` (REST `GET /v1/catalog/:name/revisions/:revision/diagnostics` + JSON-RPC)—no removal wire surface this batch; removal stays a plain in-process function. In-process-only reference accounting is a known, deliberate scope limit: under `ownership: 'workflow-lease'` a second engine process sharing the same durable store has its own empty signals and can remove a revision another process still has registered—durable, cross-process tracking depends on the same run-level revision pinning the five always-zero fields are waiting on. No persisted-data schema change: removal deletes an existing `catalog-entry:` key via the same CAS machinery WFT-9/WFT-10 already established, adding no new key shape, so `CURRENT_PERSISTED_DATA_SCHEMA_VERSION` is not bumped. See [Reference Accounting and Removal](documentation/guides/workflow-versioning.md#reference-accounting-and-removal), [Catalog Events](documentation/reference/api-events.md#catalog-events), and [the diagnostics endpoint](documentation/reference/api-observability.md#get-v1catalognamerevisionsrevisiondiagnostics).

### Changed

- The generated operation client (`client.operations`) now types discriminated-union outputs (WFT-93): `scripts/generate-operation-client.ts` routes JSON Schema `oneOf` through the same union path as `anyOf`, so `weft.tasks.get` (eight branches on `state`, with the nested `terminal` union on `disposition`), `weft.workers.drain`, `weft.workers.resume`, `weft.worker.deployments.drain`, `weft.worker.deployments.resume`, and `weft.workflows.finalizer.get` (a `oneOf` under `anyOf`, so `| null`) surface as narrowable unions instead of `unknown`. No other operation's generated shape changes; `allOf` and co-occurring combinators now degrade to `unknown` explicitly rather than honouring one keyword and dropping the rest. `weft.workflows.get` keeps `unknown`, since its runtime `outputSchema` is deliberately `z.unknown()`.
- **`WorkflowCatalog.activateCandidate()` now requires `expectedGeneration` once a workflow name has an active pointer** (WFT-11): an omitted `expectedGeneration` there now refuses with a new `{ applied: false, reason: 'expected-generation-required' }` result instead of silently falling through to the compatibility check alone — closing the "two concurrent refreshers silently last-write-win" hazard the guarded activation primitive existed to prevent. The very first activation of a name (no active pointer yet) is unaffected: omitting `expectedGeneration` (or supplying exactly `0`) still bypasses the fence, matching the existing pre-WFT-11 contract. This primitive is reachable only through `engine.workflows.activate()` (new, above) — no existing caller (`engine.register()`'s unconditional `activateRegistered` path) is affected.
- **`buildRegistrySnapshot()`'s `activeRevisions` invariant is relaxed from "must equal the freshly built manifest's revision" to "a pointer must exist"** (WFT-11): before this batch, the only producer of a catalog active pointer (`engine.register()`) always kept it in lockstep with the live in-process registration, so the stricter equality held by construction and a mismatch was treated as an unreachable Weft bug. `engine.workflows.activate()` is a second, independent producer that can legitimately activate an installed revision different from what this process currently has registered — `activeRevisions[name]` and the matching entry in `workflows[]` are now allowed to diverge; only a genuinely absent pointer for a registered workflow remains an invariant violation. `weft codegen`'s own `resolveActiveWorkflowEntries` (`codegen-validate.ts`) matches this relaxation: an `activeRevisions` entry with no corresponding `workflows` manifest is now omitted from the generated registry rather than failing the whole codegen run, mirroring the console's existing no-match-means-omit resolution — a divergent name simply has no generated types.

- **`GET /v1/registry` (`weft.system.registry`) advances to `registryVersion: 2`** (WFT-6): `workflows` is now an array of `WorkflowRevisionManifest` (WFT-5's canonical vocabulary), sorted by `(name, revision)`, and a new `activeRevisions: Record<name, revision>` pointer map names each workflow's currently active manifest; `generatedAt` (ISO-8601, informational) is also new. `activities` is unchanged — still a flat `Record<name, entry>`. A registered workflow's tags now come back **alphabetically sorted** on the wire rather than in registration order (`normalizeWorkflowContract` sorts them), and a registration whose contract exceeds a WFT-5 hostile-input limit (identifier over 512 bytes, more than 512 signal/update/query/activity entries, schema nesting past 64 levels, or a normalized contract over 256 KiB — none of which the engine itself enforces at registration time) now fails the whole snapshot with a masked `500` rather than succeeding. `weft codegen` and both the built-in server and Console consume the new shape; `registryVersion: 1` is rejected outright with `codegen: registryVersion 1 is not supported (expected 2); upgrade or regenerate the snapshot` — Weft is pre-release, so there is no v1 compatibility layer. See [the migration guide](documentation/guides/migration.md#migrating-from-023x-to-0240) and [`api-server.md`](documentation/reference/api-server.md#registry-snapshot).
- **A workflow's `.activities({...})`-scoped activity registrations now fold into its registry manifest's `contract.activities`** (WFT-6), via the new `Engine.listWorkflowActivityDefinitions(workflowType)` method. Previously a scoped activity's schema was entirely absent from `buildRegistrySnapshot`'s output, so changing only that schema left the owning workflow's `contractHash`/`revision` unchanged even though the workflow's effective contract had changed. A workflow with no `.activities({...})` step still omits `contract.activities` entirely, matching this module's "absent fields omitted" convention. See [`api-engine.md`](documentation/reference/api-engine.md#listworkflowactivitydefinitions).
  - This also changes `buildWorkerManifestFromRegistry()`'s workflow-level `contractHash`/`workflowRevision` for a workflow with scoped activities: that manifest's `baseContract` is now the same registry manifest, so an empty caller-declared `workflows: { <type>: [] }` no longer means "no activities in the hashed contract" — the workflow's own scoped activities are already present on `baseContract.activities` and only get overridden when the caller's own `activityNames` list is non-empty. Per-activity worker manifest entries (`manifest.workflows[type].activities`) are unaffected — those still strictly follow the caller's declared list.
- **`GET /v1/registry` now enforces a 512-workflow aggregate ceiling at snapshot-build time** (WFT-6), mirroring the per-workflow limits above: `Engine.register()` itself enforces no such ceiling, so an engine that has accumulated more than 512 registered workflows previously produced a valid but ever-larger snapshot; it now fails the whole snapshot with a masked `500` (`RegistryWorkflowCountLimitError`, logged server-side with the actual count) instead. `weft codegen --server`'s own consumer-side ceiling on the `workflows` array it reads from the wire shares the same 512-workflow limit (`core/registry-limits.ts`), so the two can never disagree — a snapshot this operation actually returns can never be rejected by `weft codegen` for exceeding the count. This ceiling is specific to the full-snapshot wire response: `buildWorkerManifestFromRegistry()` still succeeds for the small set of workflows its caller names even when the source engine has more than 512 registrations elsewhere, or when an _unrelated_ registered workflow individually exceeds its own WFT-5 contract limit — it resolves each requested workflow's manifest directly (the new `buildWorkflowManifestForType()`, `core/registry-workflow-manifest.ts`) rather than building and hashing the full registry snapshot just to look one workflow up.
- `buildWorkerManifestFromRegistry()`'s `contractHash`/`workflowRevision` (per workflow) and `contractHash` (per activity) now route through the same canonical `contractHash()`/`deriveWorkflowRevision()`/`activityContractHash()` functions above, instead of the ad hoc hashing `registry-contract-builder.ts` previously rolled itself. Digest **strings** for an otherwise-unchanged registration differ from prior 0.23.x output because the new formula folds in a `contractVersion` domain separator the old one never had — this is a value change, not a shape change (`WorkerManifest`/`WorkerWorkflowContract`/`WorkerActivityContract`'s TypeScript types and wire format are untouched). `contractHash` also now depends on which activities the caller's `options.workflows[type]` names (previously independent of that list), which is the intended effect of a payload identity that answers "what can a caller do with this workflow" rather than only "what does the workflow's own input/output look like." See [the migration guide](documentation/guides/migration.md#migrating-from-023x-to-0240) if you pin literal digest strings in your own tests or fixtures.
- `weft codegen` now emits `revision`/`workflowVersion` as required, string-literal-typed fields on every generated `WorkflowRegistry` entry (WFT-7), alongside the existing `input`/`output`. Neither field is required by `engine.start`/`WeftClient.start`/`.schedule()`, which continue to read only `input`/`output` structurally — an ordinary start needs no caller-supplied revision. The emitter also now deduplicates a repeated, non-trivial `inputSchema`/`outputSchema` shared by two or more workflows in the same snapshot into a single content-hash-named `type` alias declared above the `WorkflowRegistry` augmentation (never inside it), referenced from every entry that shares it, instead of repeating the same inline type at each call site. Re-running `weft codegen` against an unchanged server now produces a different `.d.ts` than before this release; regenerate once to pick up the new fields. See [`cli.md`](documentation/reference/cli.md#codegen).

### Fixed

- `buildWorkerManifestFromRegistry()` now folds a registered definition-level `finalizer`'s schema into `contractHash`/`workflowRevision`, and resolves each declared activity through the same workflow-scoped-then-global path `activity-resolution.ts` uses at dispatch (a per-workflow `.activities({...})` registration now wins over a same-named global one, matching what actually executes) — both are digest-value changes for affected registrations, not shape changes. `Engine.listWorkflowDefinitions()`/`Engine.getWorkflowDefinition()` now also report a registered finalizer's `name`/`inputSchema`/`outputSchema` (never its handler), and the new `Engine.getWorkflowActivityDefinition(workflowType, activityName)` exposes the same scoped-then-global resolution directly.
- `buildWorkflowRevisionManifest()` now applies the same bounds `parseWorkflowRevisionManifest()` enforces (`identifier-too-long`, `too-many-entries`, `manifest-too-large`) and throws if the manifest it built would fail its own parser, instead of silently producing a manifest a later `parseWorkflowRevisionManifest()` call would reject. `parseWorkflowRevisionManifest()` also now bounds `contract.tags` by entry count (`MAX_CONTRACT_MESSAGE_COUNT`, matching `signals`/`updates`/`queries`/`activities`) and accumulated bytes while walking the array, before it is copied and sorted — a contract with more than 512 tags is now rejected even when the tags are individually short enough that the total normalized size was previously within bounds.
- `engine.register()` now defaults an unversioned workflow's stored `version` to `DEFAULT_WORKFLOW_VERSION` (`'0.0.0'`) instead of the literal string `'1'`. This aligns registration with what `diagnostics/version-check.ts`, `worker/manifest/internal-realm.ts`, and `worker/options.ts` already assumed the unversioned default was — those three already fell back to `DEFAULT_WORKFLOW_VERSION` themselves, so this was a real, pre-existing inconsistency (registration alone used the stale literal). Recovering a workflow that was started while unversioned under an older release (which persisted `version: '1'`) against a still-unversioned re-registration now compares stored `'1'` against registered `'0.0.0'` and is rejected as a version mismatch; see [the migration guide](documentation/guides/migration.md#migrating-from-023x-to-0240).

## [0.23.1] - 2026-09-01

### Fixed

- Worker realm-ready tests now synchronize on observable handshake and checkpoint state instead of event-loop timing, avoiding intermittent suite failures under concurrent load; optional `better-sqlite3` native-binding diagnostics also preserve the actionable peer-dependency error when the native binding is unavailable.

## [0.23.0] - 2026-09-01

### Added

- Fleet event feeds now persist one ordered cursor space across processes, support durable replay and retention-gap notices, expose direct-host configuration through the public handler API, and recover live delivery from storage without relying on an in-memory handoff buffer.

### Changed

- **Upgrade warning:** this release advances the persisted-data schema from version 1 to version 2. Stores created by Weft 0.22.x are rejected at startup with `PersistedDataIncompatibleError`; start 0.23.0 with a fresh store or explicitly archive and replace the existing store before upgrading. There is no in-place migration for persisted workflows.

### Fixed

- `WeftServer.getTaskResult()` no longer exposes internal synthetic `resultDigest` values for cancelled or retry-exhausted tasks, preventing those values from revealing the task's attempt token. Resolved task views continue to expose their content digest for adoption checks, while non-resolved terminal tasks expose a one-way, incarnation-fenced adoption token for retention cleanup.

## [0.22.1] - 2026-08-31

### Added

- Export `RegistryAgnosticEngine` from the package root so libraries can retain engines created with a workflow registry while preserving typed runtime dispatch methods and excluding registry-building methods.

## [0.22.0] - 2026-08-26

### Added

- `weft.tasks.diagnostics` and `GET /v1/tasks/diagnostics` can now expose expected delayed queued attempts and elapsed unadopted terminal results through the typed `delayed` and `unadopted-terminal` diagnostic variants. Delayed visibility remains opt-in with `includeExpectedDelayed`; terminal non-adoption uses the configurable `unadoptedAfterMs` threshold.

## [0.21.0] - 2026-08-26

### Added — `ownership: 'workflow-lease'` fenced per-workflow ownership

`Engine.create({ ownership: 'workflow-lease' })` is now a working mode: multiple
engine processes can share one durable store, and every workflow has exactly
one fenced owner before its generator advances. Previously only
`ownership: 'lease'` (one engine process per store) and `ownership: 'none'`
were supported; `'workflow-lease'` closes the gap where two engines racing to
resume the same workflow could both execute user code before a checkpoint
commit picked a winner — the loser's already-observable side effects (an
external API call inside `ctx.run()`, for example) could not be undone by a
losing compare-and-swap.

Ownership claims are taken before a workflow's generator advances, renewed on
a dedicated lifecycle task, and reclaimed from a crashed or deposed owner by a
recurring sweep that also drives the reclaimed workflow forward rather than
leaving it idle. Cross-engine signal delivery, `ctx.startChild()` completion,
`query()`, and inline update handlers are all ownership-aware, so a
non-owning engine no longer serves stale reads or silently drops signals and
child results. Deployment scenarios — rolling release, graceful shutdown,
crash, claim-expiry, takeover, and rollback — are covered against two real
engines sharing one store (see [ADR
0002](documentation/contributing/architecture-decisions/0002-multiengine-per-workflow-ownership.md)).

`ownership: 'none'` and `ownership: 'lease'` are unchanged. Documentation
previously described `'workflow-lease'` as "not yet available"; that guidance
is corrected in the configuration reference, the singleton guide, `README.md`,
and `AGENTS.md`/`CLAUDE.md`.

### Changed

- The release workflow no longer opens downstream "bump" issues in other
  repositories after publishing to npm; the `notify-downstream-repositories`
  job and its repository list are removed. Downstream consumers should track
  new releases directly (npm, GitHub releases, or their own polling) rather
  than relying on an automatically filed issue.

## [0.20.0] - 2026-08-21

### Added — `weft.tasks.get` / `GET /v1/tasks/detail/:operationId`

A new read-only operation returns one task's full durable ledger state over
REST and JSON-RPC — the wire-reachable counterpart to the same-process-only
`WeftServer.getTaskResult()`. Unlike `weft.tasks.diagnostics`, which collapses
`leased`/`completing`/`cancelling` into one `inflight` value for alerting
purposes, this operation distinguishes all six ledger states and carries the
full dispatch envelope (attempt identity, queue, priority, header key names,
retry policy, visibility timeout, schedule-to-close deadline, execution
requirement, fair-share key, sticky routing, retry availability) plus
state-specific evidence (terminal disposition, `resultDigest` for resolved
dispositions, adoption markers, dead-letter reason). The REST path lives
under `/v1/tasks/detail/`
rather than a bare `/v1/tasks/:operationId`, so a task whose caller-supplied
`operationId` happens to equal an existing sibling literal path (currently
`diagnostics`) is still reachable. Faults `NotFound` for a missing or
already-reaped `operationId`, and `EngineFailure` (distinct from `NotFound`)
if the stored record exists but fails to decode — a data-integrity signal,
not a normal absence. Purely additive — no existing operation's behavior
changes. Adoption stays same-process-only; there is no HTTP path to
`adoptTaskResult`.

### Fixed

- Hardened `prepack`'s real-Node resolution against Bun-compat shim confusion,
  where a re-delegating shim on `PATH` could be mistaken for a genuine Node.js
  binary.

## [0.19.0] - 2026-08-20

### Changed — RemoteWorker protocol v3: canonical worker manifest replaces parallel identity fields

The RemoteWorker WebSocket protocol version is now `3`. `register` no longer
carries `activities`, `queue`, `deploymentName`, `buildId`, `runtimeVersion`,
`gitSha`, or `capabilities` as parallel top-level fields — it carries a single
`manifest: WorkerManifest`. The server derives routing activities from
`manifest.workflows`, deep-validates the manifest with `parseWorkerManifest()`,
checks `(deploymentName, buildId)` against previously seen artifact digests,
and — when `ServeOptions.workerAdmissionPolicy` is configured — runs that
policy before admitting the worker. `registerAck` echoes
`acceptedManifestDigest` and `serverCapabilities` instead of echoing
`activities` back. `registerError` gains two new codes: `deployment_conflict`
(the manifest's `(deploymentName, buildId)` was already registered with a
different `artifactDigest`) and `registration_rejected` (a configured
`WorkerAdmissionPolicy` refused the worker).

`gitSha` is retired everywhere: `RemoteWorkerOptions`, the registry's
`WorkerInfo`/`WorkerSummary`/`WorkerDeploymentSummary`, and the REST/JSON-RPC
`weft.workers.list` output. A commit is metadata, not an executable identity;
`WorkerManifest` never had a field for it.

`RemoteWorkerOptions.deploymentName` and `buildId` are now required —
defaulting them risked a false deployment-conflict collision between two
unrelated apps that both skipped the option. `runtimeVersion` now defaults to
`detectRuntimeVersion()` when omitted rather than being sent blank. A new
optional `artifactDigest` lets real build tooling supply a trusted content
digest; when omitted, the SDK derives a placeholder tagged
`declared-shape:<hash>` from the declared workflow and activity names, so it
is never mistaken for a real content digest.

`RemoteWorker` now accepts exactly one queue configuration source: a bare
server origin plus the `queue` option (or its default), or a complete
worker-stream `serverUrl` that already encodes a queue and no `queue` option.
A `serverUrl` encoding a queue that conflicts with an explicit `queue` option
now throws at construction time instead of silently connecting to one of the
two.

**Migration**: upgrade both server and worker SDK together — v3 is a clean
break with no negotiation, and a v2 worker connecting to a v3 server (or vice
versa) receives the canonical protocol-incompatibility error. Worker
construction call sites must add `deploymentName` and `buildId`; call sites
that supplied `gitSha` should drop it. Server hosts that inspected
`WorkerSummary.gitSha` or `WorkerDeploymentSummary.gitSha` must remove that
read. Hosts that want to gate worker registration should configure
`ServeOptions.workerAdmissionPolicy`.

### Changed — durable remote task ledger replaces the op:queued:/op:inflight:/op:resolved:/op:dead-letter: keyspace

A single authoritative `task-ledger:<operationId>` record, proven through
`storage.conditionalBatch` at every transition (`Queued -> Leased ->
Completing -> Terminal`, plus a new `Completing -> DeadLettered`
escalation), replaces the four separate `op:queued:`/`op:inflight:`/
`op:resolved:`/`op:dead-letter:` keyspaces. `get-task-diagnostics.ts` is
fully migrated onto a single `task-ledger:` scan.

**Added**: `WeftServer.getTaskResult(operationId)` and
`WeftServer.adoptTaskResult(operationId, resultDigest)` give a same-process
caller an explicit way to read a terminal task's `TaskResultView` and assert
adoption. Adoption and cleanup are separate durable facts — a terminal
record an adopter never calls this for is retained forever, by design.
`ServeOptions.taskRetentionWindowMs` opts _adopted_ terminal records into
time-based reaping via the existing `reconcileOrphanedRecords` scan; it
defaults to `undefined` (keep forever), so upgrading never starts silently
deleting data. A `Completing -> DeadLettered` escalation dispatches a new
`TaskResultDeadLetteredEvent` when a terminal-commit write exhausts its CAS
retry budget, instead of leaving the record stuck in `completing`.
`WeftServer.ready` exposes a settled-promise readiness gate that the
startup task-ledger recovery scan (`runTaskLedgerRecovery`, replacing the
old unawaited `restoreInflightTasks`) resolves once every non-terminal
record has been examined and its recovery action initiated — lease
ownership rehydrated, a queued record's redispatch scheduled, or an
expired lease requeued/exhausted. `ready` marks scan completion, not that
every scheduled redispatch has actually run by the time it resolves.

**Breaking**:

- `TaskDispatch.workflowType` is now required.
- `TaskDispatch.attempt` is removed. It previously had real effect — fresh
  dispatch persisted it into the queued/in-flight record, sent it in the
  worker task frame, and used it to seed the initial retry count — so a
  caller that seeded a non-default `attempt` will see different behavior.
  Attempt tracking is now entirely ledger-owned.
- A task-result completion for an unknown or unauthorized `operationId` is
  now a hard rejection: REST returns `403`, and WebSocket sends a
  `protocolError` frame back to the worker instead of applying it silently.
- A terminal ledger record permanently blocks re-dispatch of the same
  `operationId` until retention reclaims it, mirroring the `start-idem:`
  spent-key contract.
- `KEYS.operationDeadLetter`/`operationDeadLetterPrefix` are removed from
  the published `@lostgradient/weft/storage` `interface` surface.
- Diagnostics retry-storm detection no longer applies to terminal records —
  a terminal ledger record carries no attempt-history fields to detect a
  storm from. This is a disclosed behavior change, not an oversight.
- Pre-upgrade `op:inflight:` records are no longer read at startup. A
  server restarting onto this version from a pre-cutover deployment will
  not resume in-flight work recorded in the old keyspace; drain the queue
  before upgrading if that matters. An expired leased record recovery
  finds is requeued if its retry policy allows another attempt, or
  transitioned straight to a terminal `retryExhausted` record if not —
  it is never silently deleted, but it is not unconditionally requeued.

**Migration**: upgrade server and any code reading `KEYS.operationDeadLetter`
together. Dispatch call sites must supply `workflowType` and drop `attempt`.
Hosts that want bounded terminal-record retention should configure
`ServeOptions.taskRetentionWindowMs`; hosts that want to observe a caller's
own dead-letter escalations should listen for `TaskResultDeadLetteredEvent`.

## [0.18.0] - 2026-08-11

### Added — principal introspection

New `weft.system.principal` operation (`GET /v1/principal`) reports the
caller's own resolved principal: authentication method, normalized subject,
and granted scopes (sorted). Public access by design — anonymous callers
receive `method: 'unauthenticated'` with an empty scope list instead of an
error, so dashboards can resolve their credential state without probing other
operations. The canonical scope vocabulary is now a public export:
`AUTHORIZATION_SCOPES`, `AuthorizationScope`, and `isAuthorizationScope` from
`@lostgradient/weft/server`, alongside the `GetPrincipalOutput` type.

## [0.17.0] - 2026-07-27

### Changed — awaited lease shutdown result

`Engine.shutdown()` now returns `Promise<boolean>` so process hosts can confirm
whether an ownership-lease holder delete committed. Update callback and stored
promise types that require `Promise<void>`. When it returns `false`, renewals
have stopped but handoff was not confirmed: a successor may already own the
lease, or a storage failure may have left the old holder valid until its
configured `leaseTtl` expires. Alert on the result and let replacement lease
acquisition distinguish those cases.

## [0.8.0] - 2026-06-24

### Added — Service Worker recovery and release automation

Browser Service Worker hosts can now opt into durable recovery with
`recover: true`, and `browser-smoke` is part of the required validation gate so
browser storage and recovery regressions are caught before release (#611, #616).

The release workflow now has a documented `release-publish` playbook and a
post-publish downstream notification job. After a successful tagged publish, the
workflow opens versioned bump issues for configured downstream repositories,
deduplicating existing issues for the same target version (#638, #640).

### Added — durable helper workflow support

Plain async helpers running inside an inline `ctx.memo()` callback can use the
package-root `durableActivity()` helper to launch durable activities while
preserving memo-scoped operation identities for retry, heartbeat,
reconciliation, diagnostics, and timeline labels (#621, #624).

### Added — explicit lease shutdown ergonomics

`Engine.shutdown()` is now the explicit awaited shutdown primitive for hosts
that need prompt lease release during process termination. Lease-owning engines
also warn on synchronous disposal through the exported
`ENGINE_LEASE_SYNCHRONOUS_DISPOSE_WARNING_NAME`, nudging rolling deployments
toward `shutdown()` or `await using` when handoff latency matters (#639).

### Fixed — worker transport and runtime hardening

Remote worker registration now rejects duplicate live `workerId` connections,
with reconnect grace still allowed for the legitimate worker, and the WebSocket
transport caps raw frames before parsing so oversized messages cannot force a
large JSON allocation (#609, #610, #614, #615).

Start-or-signal restart behavior, durable lease-fenced writes, async activity
completion, opaque signal identifiers, and JSON negative-zero handling gained
additional regression coverage and documentation refreshes to keep the runtime
contract pinned across future cleanup work (#613, #617, #623, #635, #637).

### Fixed — coverage and documentation gates

Runtime coverage is back at the repository's deterministic 100 percent adjusted
coverage gate, with refreshed coverage guidance for the restoration workflow
(#620, #625, #626). Public documentation, agent guidance, and mirrored skills
were refreshed around durable helper workflows, worker and restart behavior,
and pull request evidence collection (#619, #624, #637).

## [0.7.0] - 2026-06-20

### Added — secure REST Server-Sent Event streams

REST now exposes authenticated Server-Sent Event feeds for workflow and fleet
events (#598). The new `weft.workflows.events.sse` and `weft.events.sse`
operations stream committed event envelopes with cursor-keyed frames, idle
`ping` keepalives, `Last-Event-ID` / `fromCursor` replay, `Accept:
text/event-stream` negotiation, sanitized in-stream error frames, and
scope-aware authorization. `maxStreamConnectionsPerWorkflow` now accounts for
workflow event SSE connections alongside the existing stream and watch paths.

`HttpClient` gains `eventTransport: 'auto' | 'websocket' | 'sse'`, keeping
WebSocket delivery as the preferred path while falling back to fetch-based SSE
when the runtime cannot construct header-capable WebSockets. Shared tail
lifecycle code now backs both WebSocket and SSE clients, reducing duplicate
iterator, buffering, close, and terminal cleanup behavior (#601).

### Added — restart-capable `startOrSignal`

`engine.startOrSignal()` can now reuse a stable workflow id after the prior run
is terminal, mirroring `engine.start(..., { onTerminalConflict: 'start-new' })`
while preserving the single start-or-signal call shape (#606). The restart path
requires an explicit workflow `id` and deterministic `signal.signalId`, rejects
`idempotencyKey`, signals non-terminal runs instead of replacing them, and
purges the terminal prior run through the shared terminal-replacement path
before creating the fresh run with its initial signal.

The option is available through `WeftClient`, `LocalClient`, `HttpClient`, REST,
JSON-RPC, generated catalog/client metadata, and public exports.
`weft.workflows.startorsignal` is now classified as destructive because this
option can purge a terminal run. `WorkflowTeardownPendingError` is surfaced as a
typed conflict when durable finalizer teardown blocks the restart.

### Added — services resolver launch context

`resolveWorkflowServices` now receives optional `launchOptions` and `schedule`
context so inline hosts can rebuild services from durable launch identity rather
than duplicating that identity in workflow inputs (#605). Recovered runs include
the workflow id and current durable tags; scheduled occurrences include the
schedule id and occurrence timestamp when known. The package root now exports
`WorkflowServicesResolverLaunchOptions` and
`WorkflowServicesResolverScheduleInfo` so consumers can name every nested field
on `WorkflowServicesResolverInfo` without deep imports (#607).

### Added — timeout and scheduler diagnostics

`WorkflowTimeoutError` now exposes an optional `terminationReason`, aligned with
`WorkflowTimedOutEvent.reason`, so callers can distinguish history
circuit-breaker termination from execution-deadline timeouts directly from
`handle.result()` / Observable errors without a second `engine.get()` lookup
(#593).

`EngineOptions.schedulerPollIntervalMs` configures the durable-timer scheduler's
real-time poll interval, with positive-safe-integer validation before it reaches
`setInterval`. `DEFAULT_POLL_INTERVAL_MS` is now wired into the scheduler and
exported for diagnostics and tests (#593).

### Fixed — coverage, documentation, and source-compatibility classification

- Restored route-match, local handle wrapper, and event-stream lifecycle
  coverage without weakening the release gates (#596, #600, #601).
- Refreshed public documentation, agent guidance, and event-streaming docs after
  the recent API changes (#597, #602).
- Reclassified source-compatibility wording in tests so compatibility assertions
  describe current contracts rather than retired compatibility layers (#595).

## [0.6.0] - 2026-06-17

### Added — `Engine.create({ startScheduler })` decouples timer polling from recovery

`Engine.create()` accepts a new `startScheduler?: boolean` option that controls
the durable-timer polling loop independently of `recover` (#590). `recover`
decides _who drives `recoverAll`_; `startScheduler` decides _whether timers
fire_. It defaults to `recover !== false`, so existing behavior is unchanged. A
host that owns its own recovery — passing `recover: false` so it can capture the
recovered handles from its own `engine.recoverAll()` — can now arm the poller
with `startScheduler: true`, so durable `ctx.sleep(...)` and
`engine.schedule(...)` timers still fire. Conversely, `startScheduler: false`
keeps the poller stopped even when recovery runs, for engines that tick the
scheduler deterministically.

## [0.5.0] - 2026-06-17

### Fixed — `ctx.race` aborts a losing `ctx.run` activity branch

When a non-activity branch wins a `ctx.race([...])`, the losing `ctx.run()`
activity branch now fires its activity's `ctx.signal` (`AbortSignal`) for
cooperative cancellation, consistent with how losing `sleep` and `wait-signal`
branches were already torn down (#584). The coordinator's `AbortSignal` is
threaded through the activity sub-operation executor and composed into
`ActivityContext.signal` alongside the workflow-cancel and per-attempt-timeout
signals, so the activity aborts when any source fires. This makes the
`ctx.race` supersede idiom self-sufficient: a superseded activity is signalled
to stop rather than running to completion and risking a stale last-writer-wins
write. This reverses the prior #453 contract that left race losers running;
the pinned cancellation test now asserts the abort-on-loss behavior.

### Fixed — `Engine.create()` starts the scheduler

`Engine.create()` now starts the scheduler's timer-polling loop on the default
recovery path (`recover !== false`), so durable `ctx.sleep(...)` timers fire in
long-lived in-process hosts without an explicit `engine.scheduler.start()`
(#586). `recover: false` (tests, isolated `ScopedStorage` engines, pre-recovery
inspection) intentionally skips the auto-start, and `TestEngine`'s manual
`advanceTime()` tick-based time control is unaffected. Disposal still stops the
scheduler via `[Symbol.asyncDispose]`.

### Fixed — public `StartOrSignalOutcome` export and `LocalClient` engine typing

`StartOrSignalOutcome` (`'started' | 'signalled'`, the type carried by the
public `ClientHandle.outcome` field and the engine's `StartOrSignalResult.outcome`)
is now re-exported from both the package root
(`@lostgradient/weft`) and the `/client` barrel (`@lostgradient/weft/client`),
so consumers can name the type to annotate their own result interfaces (#583).
The `LocalClient` constructor is now generic over the engine's workflow
registry, so a branded engine returned by `Engine.create({ workflows })` is
accepted without a cast: the canonical in-process topology
`Engine.create({ workflows }) → new LocalClient(engine)` type-checks directly
(#585).

## [0.4.0] - 2026-06-17

### Added — replay-safe structured logging

`WorkflowContext` now exposes `ctx.log`, a structured logger with `.debug()`,
`.info()`, `.warn()`, and `.error()` methods (#447). Each call auto-carries
`workflowId`, `workflowType`, `level`, and `timestamp` in an engine-owned
envelope; caller attributes nest under an `attributes` key so they cannot shadow
envelope fields. Logging is replay-safe in both inline and worker execution
modes: a call within the already-committed replay window is suppressed without
consuming a durable step, while a log at an uncached live frontier may re-emit
after recovery. The `WorkflowLogger` type is exported from the package root for
typing injected loggers.

`EngineOptions.onLog` is a new optional host sink that receives `ctx.log`
records from both execution modes — inline directly, and worker-mode forwarded
back to the host over a non-terminal `log` protocol message (#491, #529). With
no sink installed, inline logs go to the host console and worker logs to the
worker console. A throwing sink falls back to console without failing the
workflow, and the same sink behavior applies inside `ctx.speculate()` branches
and across recovered and forked inline contexts (#533, #535, #549). The
worker-forwarded log lane is internally rate-limited so a misbehaving worker
that floods or repeatedly sends malformed records is torn down, without
affecting honest high-log workflows (#545).

### Added — `ctx.waitUntil` condition gate

`ctx.waitUntil(predicate, timeout?)` is a new inline-only durable condition
primitive (#448). It re-evaluates a pure predicate each time `ctx.onUpdate()`
drives workflow-local state, and consumes one durable slot regardless of how
many times it wakes. With a `timeout`, it resolves `true` once the predicate
holds or `false` if the deterministic deadline elapses first (predicate-first,
so a predicate true exactly at the deadline counts as met); without a timeout it
waits indefinitely and resolves `void`. Signals do not re-drive it, and it is
rejected inside `ctx.race()`, `ctx.all()`, and `ctx.speculate()` with an
actionable error.

### Added — sleep and wait-signal branches in `ctx.race` / `ctx.all`

`ctx.race()` and `ctx.all()` now accept `ctx.sleep(duration)` and
`ctx.waitForSignal(name)` branches alongside `ctx.run()` branches (#456). Sleep
branches use abortable in-process timers. Wait-signal branches use a
deferred-consume protocol that consumes a durable signal record only for a
branch whose result is actually kept: under `ctx.race()` that is just the
winning branch, so a losing wait-signal branch drops its envelope unfinalized
and leaves the signal available for a later `waitForSignal`; under `ctx.all()`
every branch is kept, so each fulfilled wait-signal branch consumes its signal,
but only once all branches have settled and immediately before the coordinator
checkpoints. Duplicate signal names within one coordination tree are rejected at
validation time.

### Added — `onTerminalConflict: 'start-new'` on `engine.start`

`engine.start(..., { id, onTerminalConflict: 'start-new' })` restarts a workflow
under an id whose prior run is in a terminal state (#452). The terminal run is
purged and a fresh run created atomically. It requires an explicit `id`, rejects
`idempotencyKey`, never displaces a non-terminal run, and is in-process
`engine.start` only — it is absent from REST, JSON-RPC, `engine.startOrSignal()`,
and `ctx.startChild()`.

### Added — durable finalizers

`WorkflowDefinition` accepts a new `finalizer` option — a definition-level
teardown activity driven post-terminal when a workflow is cancelled or times out
(#446). The engine drives it durably with retry and backoff, re-drives it on
crash recovery, and dead-letters it after a bounded horizon.
`ctx.setFinalizerState(value)` records the payload the finalizer receives and
commits it atomically with the next checkpoint or the terminal batch. A new
`WorkflowTeardownEvent` (kind `workflow:teardown`) is emitted as the finalizer
progresses; its `status` field carries `WorkflowTeardownStatus` —
`'completed'`, `'failed'`, or `'dead-lettered'`. Purge, bulk-delete, and
`onTerminalConflict: 'start-new'` are blocked while teardown is pending: purge
and bulk-delete skip the run and surface it under `skippedTeardownPending`,
while a restart throws `WorkflowTeardownPendingError`. The finalizer activity
always runs on the engine host, so registering a `finalizer` is allowed under
both inline and worker execution modes; staging teardown state via
`ctx.setFinalizerState` works only under inline execution, since the
worker-side `ctx` does not carry that method.

### Added — lease-fenced single-writer ownership

`EngineOptions.ownership: 'lease'` opts an engine into durable single-writer
ownership of its store (#470). The engine acquires a two-key storage lease
before `recoverAll()`, renews it on a heartbeat, and releases it on dispose;
`leaseTtl`, `leaseRenewInterval`, and `leaseWaitTimeout` tune the timings. Every
engine-owned durable write — including the scheduler's fired-timer cleanup
(#563) — is fenced on the lease epoch, so a deposed zombie engine's writes lose
a CAS against the successor's newer epoch and trigger a deferred teardown. New
error types `EngineLeaseAcquisitionTimeoutError`, `EngineLeaseCorruptedError`,
and `EngineLeaseNotHeldError`, plus the `ENGINE_LEASE_LOST_WARNING_NAME`
constant, are exported. The default remains `ownership: 'none'`.

### Added — fleet-wide event streaming

A new JSON-RPC WebSocket operation `weft.events.subscribe` provides a
fleet-wide event feed with optional `workflowId` and `kind` filters and a
`fromCursor` replay cursor over retained events (#577). It requires the
`events:read` scope. Two new engine events accompany it — `worker:connected`
(`WorkerConnectedEvent`) and `worker:disconnected` (`WorkerDisconnectedEvent`) —
and the per-workflow `weft.workflows.events` subscription gains the same
replay-from-cursor capability.

### Added — client ergonomics

`WeftClient.getHandle(id)` is a new transport-uniform handle lookup on
`WeftClient`, `LocalClient`, and `HttpClient`: it returns `null` when no
workflow with that id exists and a handle whose `result()` resolves immediately
from persisted state for terminal runs (#467). `engine.startOrSignal()` now
returns a per-call handle carrying `outcome: 'started' | 'signalled'`, with the
REST `start-or-signal` response body gaining a top-level `outcome` field and
`StartOrSignalOutcome` exported from the root (#466). A new `isWeftFault(error,
code)` predicate matches both in-process `WeftError` subclasses and
HTTP-wrapped faults carrying a `weftCode`, so transport-neutral code can branch
on error codes without `instanceof` checks (#465).

### Added — activity surface extensions

- `ActivityCallOptions.scheduleToCloseTimeout` is a cross-attempt wall-clock
  budget for an entire `ctx.run()` call, anchored on the step's first dispatch;
  overshooting throws `ActivityScheduleToCloseTimeoutError` (failure category
  `timeout`), now registered in `WeftErrorCode` and recognized by `isWeftFault`
  (#449).
- `ActivityContext.lastHeartbeatDetails` exposes the prior attempt's last
  `heartbeat()` payload, keyed per `(workflowId, step)` so a later step never
  inherits an earlier step's heartbeat (#450). It is cleared after a successful
  attempt so the next attempt starts clean (#487), and a development warning
  fires when a retry at `attempt > 1` recorded none (#493).
- Each activity attempt receives an `AbortSignal` that fires cooperatively as
  the per-attempt timeout budget is about to be exhausted, giving the
  implementation a chance to cancel in-flight work before the framework marks
  the attempt timed out (#494).

### Added — `schedule:fired` event

A new `ScheduleFiredEvent` (`schedule:fired`) is dispatched on the engine each
time a schedule actually launches an occurrence (#471). It carries `scheduleId`,
`workflowId`, `firedAt` (the actual launch time), and `occurrence` (the
scheduled grid timestamp, `undefined` for queue-drained runs). Delivery is
process-local and best-effort after the durable start commits; skipped ticks
stay silent, and catch-up occurrences during recovery emit exactly once.

### Added — MCP anonymous-session continuation token

Every session-creating MCP `initialize` response now carries a random
`Mcp-Session-Token` alongside its `Mcp-Session-Id`, disclosed exactly once and
never echoed again (#525). The token is _required_ only to continue an anonymous
session under `authRequired: false`: every subsequent `POST`, `GET`, and
`DELETE` for such a session must echo it, and a missing or wrong token is
rejected with `403`. Authenticated callers re-present their credential on each
request, so their session binding is unchanged and is not gated on the token.

### Added — Neon storage schema/table configuration

`NeonStorageOptions` accepts optional `schema` and `table` identifiers (#468),
validated at construction and injected as SQL identifiers rather than string
parameters. A custom `schema` triggers `CREATE SCHEMA IF NOT EXISTS`, letting
multiple engines share one Neon database under distinct schemas.

### Changed — collapsed Neon batch round trips

`NeonStorage.batch()` and `conditionalBatch()` now resolve to the net effect per
key (last write wins, with the put-set and delete-set kept disjoint) and issue
at most one `unnest(...)` upsert plus one `DELETE ... = ANY(...)` per call,
regardless of operation count (#469). `conditionalBatch` reads all preconditions
with a single `key = ANY(...)` query inside the same `SERIALIZABLE` transaction
as its writes, and the whole `read → compare → write → commit` cycle is retried
as a unit on a `40001` serialization failure. This collapses O(keys) sequential
round trips to O(1) per attempt for checkpoint commits.

### Changed — `startOrSignal` same-tick ordering and signal key format

The start signal is now always consumed before any concurrent anonymous signal
buffered for the same workflow in the same event-loop tick (#458). Making this
deterministic required changing the internal buffered-signal storage key layout.
**This is a breaking change to the persisted key format**: there is no migration
path for in-flight buffered signals across the boundary, so drain in-flight
signals and upgrade between runs rather than mid-run.

### Changed — scheduled occurrences resolve workflow services

`engine.schedule()` occurrences now run `resolveWorkflowServices` before
launching, so per-run inline `services` are re-provided on scheduled launches
(#459). A missing or throwing resolver fails only that occurrence (failure
category `system`) and leaves the schedule active, ordered as `schedule:fired`
before `workflow:failed`.

### Changed — additional public surface refinements

- `WorkflowContext.workflowType` is now a required `readonly` member of the
  interface, not just a property on the concrete class (#451).
- Inline workflows parked on `ctx.waitForSignal()` now keep their `ctx.onQuery()`
  handlers callable while parked, switching to the fresh context on resume and
  tearing down on suspend or terminal cleanup (#457).
- `Engine.create({ workflows: {} })` is now equivalent to omitting `workflows`
  and yields the default-registry engine accepted by `ServeOptions` (#455).

### Removed (breaking) — historical compatibility shape

The `{ definition: { name } }` element shape previously tolerated by
`collectToolVersions` has been removed (#514). Callers must supply `{ name,
version? }` directly; the old shape now fails at compile time and at runtime.

## [0.3.0] - 2026-06-06

### Added — durable step-based workflows

`ctx.step(name, fn)` (the "progressive disclosure" API compiled with
`compileStepWorkflow`) is now genuinely crash-durable. Each step routes through
the same positional replay machinery as `ctx.run`, so a completed step is
replayed from the checkpoint rather than re-executed on recovery. Durability is
positional, so steps must be awaited in order; step workflows require
`workflowExecutionMode: 'inline'` and fail fast with an actionable error under
worker mode.

### Added — Neon/Postgres storage adapter

New `@lostgradient/weft/storage/neon` export with `NeonStorage` and
`resolveStorage({ type: 'neon' })`, backed by the official `@neondatabase/serverless`
driver. The driver is an **optional peer dependency** — it is not installed
automatically; add it to your project (`bun add @neondatabase/serverless`) when
you use `NeonStorage`, and the adapter imports it lazily. Stores opaque bytes
with lexicographic scan ordering and full
`get`/`put`/`delete`/`scan`/`batch`/`conditionalBatch` support. `assertDurableStorageForRecovery()` now accepts `persistence: 'remote'`
for a durable remote store that proves linearizable read-after-write, snapshot
scans, atomic batches, and `conditionalBatch`. Neon integration tests skip
cleanly without `NEON_DATABASE_URL`.

### Added — idempotent starts and atomic `startOrSignal`

`engine.start(..., { idempotencyKey })` now enforces at-most-once creation with
a durable `start-idem:` mapping committed atomically via `conditionalBatch`; `id`
and `idempotencyKey` are mutually exclusive. New `engine.startOrSignal()`
(signal-with-start) creates a workflow and persists a signal atomically when
absent, signals when running, and reports a `Conflict` fault when terminal.
Surfaced through `Engine`, `LocalClient`, `HttpClient`, REST, JSON-RPC, and the
generated operation client. A spent idempotency key whose workflow record is
gone surfaces a conflict rather than starting a replacement.

### Added — RemoteWorker attempt tokens

Each dispatched attempt now carries a unique `attemptToken` that the worker
echoes on completion; the server validates `(operationId, workerId,
attemptToken)` so a stale same-worker completion after reassignment is rejected.
Validation is lenient (an absent echo falls back to the prior workerId-only
check) to keep single-worker deployments from livelocking. No worker protocol
version bump.

### Changed — suspend/resume stabilization

`engine.suspend()` / `engine.resume()` are surfaced through `LocalClient`,
`HttpClient`, REST, and JSON-RPC. Suspend parks before the durable commit;
cancel/fail now transition a suspended workflow to terminal and reject
outstanding `result()` waiters (previously they could hang); the execution
deadline is re-armed on resume; worker-mode suspend loads state before rejecting
the mode.

### Added — singleton second-instance detector

Optional, best-effort startup guard (`detectSecondInstance`, default off) that
warns when a second engine process appears to be running against the same
durable store. Detection is sequence-based (a foreign monotonic heartbeat
sequence advancing across two of our ticks), so it survives skewed or frozen
peer clocks. This is a misconfiguration warning, not fencing — Weft remains one
engine process per durable store. Ships with a singleton-deployment guide.

### Added — history circuit breaker

New `EngineOptions.history: { maxEvents?: number }`. Activation rehydrates a
workflow by replaying its event log, so cost is O(history); an unbounded log
(e.g. a runaway infinite-yield loop) can stall the shared single-process engine
for every workflow. When `maxEvents` is set, a workflow whose durable event-log
record count would exceed it is forced to a terminal `timed-out` state — both on
the per-yield checkpoint write path and before replaying an already-oversized
history at recovery. The terminal state and the emitted `WorkflowTimedOutEvent`
carry a distinct `terminationReason: 'history-circuit-breaker'`
(`HISTORY_CIRCUIT_BREAKER_REASON`) so operators can tell circuit-breaker
termination apart from an ordinary deadline timeout. There are no baked-in
defaults; omit `history` (or set `maxEvents: 0`) to disable. New public exports:
`HistoryPolicy`, `TerminationReason`, `HISTORY_CIRCUIT_BREAKER_REASON`, and
`WorkflowState.terminationReason`.

### Removed — multi-tenancy (BREAKING)

weft is now single-tenant by default. The open-source core exposes generic
prefix-scoping primitives, not tenant policy. All built-in tenancy and per-tenant
quota machinery has been removed. This is a breaking change to the public API,
the wire contract, and the persisted-state shape.

Removed public exports (from `weft`): `tenantFromInputField`, `TenantContext`,
`TenantResolver`, `QuotaExceededError`, `TenantQuotaOptions`, `TenantQuotaUsage`,
`TenantQuotaMetricUsage`, `TenantWorkflowCreationRateLimit`, and
`TenantWorkflowCreationRateUsage`.

Removed engine surface: `EngineOptions.tenantResolver`, `EngineOptions.quotas`,
`engine.getQuotaUsage()`, `ctx.tenant`, and `ctx.state.tenant()`. The
`ctx.state.workflow()` and `engine.state.workflow()` factories no longer take a
tenant id — workflow-type-shared durable state is now namespaced under a constant
default scope. `ListFilter.tenantId` and aggregate `groupBy: 'tenant'` are gone.

Removed server surface: the `GET /v1/tenants/:id/quota` REST route, the
`quota:read` authorization scope, the `RateLimited` fault code (and its HTTP 429
mapping), and the JWT tenant-claim plumbing on the authenticated principal.
Schedule operations no longer accept tenant access options or filter by tenant.

Persisted state: the optional `tenant` field on workflow state and schedule
records is no longer written. The checkpoint schema version is unchanged
(`CURRENT_CHECKPOINT_SCHEMA_VERSION = 2`); a legacy `tenant` field on an older
persisted record is tolerated and dropped on read, so existing workflows and
schedules still decode and resume. State written under a previously configured
tenant partition (`state:workflow:<tenantId>:…`, `state:tenant:<tenantId>:…`) is
intentionally not migrated: migrating legacy partitions to the default scope
requires operator involvement and should be planned as a separate operation.
Workflow-shared state now lives under the `state:workflow-scope:` prefix, which
is deliberately distinct from the legacy `state:workflow:<tenantId>:` layout so a
historical tenant id equal to the default scope cannot alias into the new global
namespace.

Retained: `ScopedStorage` (the generic prefix-namespacing primitive) is
unchanged. Workflow-owned state is still written under a constant default scope
prefix rather than at the storage root, so a future re-partition is a key rename
rather than a data migration.

### Changed — failure category semantics

`FailureCategory` remains part of the public workflow visibility surface, but
its values are now execution-oriented instead of AI-agent-oriented:
`application`, `timeout`, `cancellation`, `resource`, and `system`. Fresh
workflow failures persist only the new values. Stored records with the old
`memory`, `reflection`, `planning`, or `action` categories are normalized on
read (`memory` to `resource`, the others to `application`) so existing workflow
state and legacy search-attribute records still surface through the new public
type.

### Changed — API surface polish

- `ctx.all([...])`, `ctx.race([...])`, and `ctx.runAll({ ... })` now preserve
  per-branch output inference in TypeScript instead of collapsing results to
  `unknown[]`, `unknown`, or `Record<key, unknown>`.
- `ChildWorkflowOptions` is now a closed shape with only the `id` field the
  engine currently reads.
- Standard Schema and Standard JSON Schema helper types moved from the package
  root to `weft/json-schema`.
- OpenTelemetry, trace propagation, metrics, and Prometheus infrastructure
  types moved from the package root to `weft/observability`.

### Renamed (breaking)

- `EngineOptions.workerExecution.concurrency` is now
  `EngineOptions.workerExecution.poolSize`, matching
  `activityExecution.poolSize`.

### Changed — Engine lifecycle and registration ergonomics

`Engine.create()` no longer recovers stored workflows by default. Pass
`recover: true` to run `recoverAll()` after definition registration, or call
`await engine.recoverAll()` explicitly after manual registration. This matches
the constructor path, where recovery has always been an explicit async step.

Activity definitions now register through `engine.register(activityDefinition)`.
The previous `engine.registerActivity()`, `engine.withWorkflow()`, and
`engine.withActivity()` sibling methods were removed so workflow and activity
definitions share one registration surface. Leaked engines now emit a
development warning when garbage collection observes that `[Symbol.dispose]`
was never called.

### Added — workflow visibility surface

`engine.list` and the `weft.workflows.list` operation now accept a richer
filter shape, and a new `engine.aggregate` / `weft.workflows.aggregate`
surface returns single-dimension group-by counts over the same filter.

- **`ListFilter` extensions.** New optional fields: `idPrefix`
  (restricted to `[A-Za-z0-9_-]+`), `createdAt` / `updatedAt` /
  `executionDeadline` time ranges (each accepts `gte`/`gt`/`lte`/`lt`),
  `tenantId` (string or array), and `failureCategory`. The `status`
  filter now also accepts an array of statuses.
- **`WorkflowSummary` extensions.** Three new optional fields are
  populated when present: `tenantId`, `executionDeadline`,
  `failureCategory`.
- **`engine.aggregate(filter, { groupBy, limit? })`** runs a single
  group-by over the visibility surface. `groupBy` is `status`, `type`,
  `tenant`, `failureCategory`, or `{ attribute: <name> }`. Groups are
  sorted `count desc, key asc`; the response carries `truncated: true`
  when more groups existed than `limit` allowed.
- **REST.** `GET /v1/workflows` accepts `?id_prefix`, `?tenant_id`
  (repeating), `?failure_category` (repeating), `?created_at_{gte,gt,lte,lt}`,
  `?updated_at_{...}`, `?execution_deadline_{...}`, and a list of
  `?status` values. `GET /v1/workflows/aggregate` is the new aggregate
  endpoint; `?group_by` accepts `status|type|tenant|failureCategory|attribute:<name>`.
- **JSON-RPC.** `weft.workflows.list` accepts the structured shape on
  every transport. `weft.workflows.aggregate` is new.
- **Errors.** Filter shape violations map to the existing
  `Unprocessable` fault (HTTP 400 / JSON-RPC -32602). New caps:
  `WorkflowListScanCapExceededError` (1,000,000 candidates) and
  `AggregateDistinctKeyCapExceededError` (100,000 distinct keys) both
  surface as `Unprocessable`. The aggregate cap is a hard error, never
  silently truncated, because scan-order would bias which groups win.

### Changed — `engine.list` ordering contract

Previously `engine.list` returned workflows in undocumented
storage-scan order, which depended on backend and on whether a
constrained-id fast path or full scan ran. The contract is now
**`createdAt` descending with `id` ascending as the tiebreaker**,
applied after filter intersection and before pagination. The prior
behavior was unspecified, so this is a tightening of the contract
rather than a break — but worth flagging for any caller that
unintentionally depended on the old order.

### Added — visibility indexes and backfill

A new family of secondary-index keys (`wf-idx-status:`, `wf-idx-type:`,
`wf-idx-tenant:`, `wf-idx-created:`, `wf-idx-updated:`,
`wf-idx-deadline:`, plus a per-workflow `wf-idx-manifest:`) lets
`engine.list` and `engine.aggregate` narrow candidates through indexes
rather than scanning every workflow.

- **Watermark gate.** The engine reads `wf-idx-meta:version` once per
  query and only consults the indexes when the persisted version
  matches `WORKFLOW_VISIBILITY_INDEX_VERSION`. Pre-watermark, queries
  fall back to the existing slow path with post-filtering — correct,
  just slower. `idPrefix` works in both states via a primary-key
  prefix scan.
- **Runtime lifecycle.** Every state-write chokepoint (start, fork,
  resume, update, tag mutation, completion, delayed-start → running,
  purge) keeps the indexes in sync via
  `buildWorkflowVisibilityIndexTransition`, which derives the
  previous-state keys directly from the prior `WorkflowState` so
  there is no extra storage read on the hot path.
- **Backfill.** `scripts/rebuild-workflow-visibility-indexes.ts`
  builds the indexes for an existing database. Conditional-batch
  pre-image guards against racing runtime writes; the watermark
  advances only on a zero-conflict pass. `--drop` removes the
  watermark first, then sweeps every `wf-idx-*` row, then clears the
  cursor — reversing the order would leave a window where the engine
  trusts a watermark for indexes that no longer exist. Storage
  backends without `conditionalBatch` must run the engine offline
  during the backfill.

### Changed — bulk filter scoping

`hasScopedBulkWorkflowFilter` (which gates destructive
`cancelAll` / `deleteAll` / `signalAll` / `mutateTagsAll` bulk
operations) now recognizes two new valid scopes:

- `tenantId` (non-empty after normalization, single or array).
- `idPrefix` (length ≥ 3 — short prefixes match too much to be safe).

`failureCategory` alone is **not** a valid scope: the engine doesn't
enforce the "failureCategory implies failed status" invariant, so
deleting on the attribute alone would be a footgun. Combine it with
`status` for a safe scope. Time ranges (`createdAt`, `updatedAt`,
`executionDeadline`) likewise need a non-temporal scope to qualify.

The error message returned when a bulk filter is too broad now
enumerates the new valid scopes.

### Removed (breaking)

The `suspendOnLlmWait` engine option has been removed from `EngineOptions` (and
therefore from the `new Engine({...})` constructor and `Engine.create({...})`
option bags). It was never functional: passing `true` threw
`'suspendOnLlmWait is not yet implemented'` at construction, and passing `false`
was a no-op. The provider-resume-hint surface it was meant to park work on was
removed in v0.1.0, so there is nothing left for it to gate.

The `weft/server/handler` subpath no longer exports the internal legacy route
precedence helpers `countLiteralSegments`, `countPathParameters`, or
`shouldPreferLegacyRoute`. Direct meta and discovery endpoints are now modeled
as reserved direct HTTP routes instead of legacy fallbacks.

The `weft/storage/compressed` subpath no longer exports
`AgentCompressionOptions`, and `CompressedStorage` no longer accepts
agent-specific compression option names (`agentWorkflowIds`, `agentAlgorithm`,
or `agentThreshold`). Compression now has one storage-level configuration path:
`CompressionOptions`.

### Removed (breaking) — deprecated workflow registration paths

The deprecated registration overloads and module-augmentation types that
bridged callers across the tRPC-style workflow-builder refactor are now
gone. The chained `workflow(options).execute(handler)` form is the only
supported path.

Removed `Engine.register` overloads:

- `engine.register(name: string, handler: WorkflowFunction): void`
- `engine.register(name: string, registration: WorkflowRegistration): void`

`engine.register(activityDefinition)` and
`engine.register(workflowDefinition)` (where `workflowDefinition` is the
result of `workflow({...}).execute(fn)`) remain supported.

Removed `workflow()` overloads:

- `workflow(handler)` (bare-function form)
- The three `workflow({ ..., handler })` options-with-handler forms
- The bare-function form previously inferred a workflow name from the
  passed function's `.name`; the builder form requires an explicit
  `name` in the options object.

Removed types:

- `WorkflowRegistration` (use `BuiltWorkflowDefinition` or the
  builder's return type instead — the builder takes the same fields
  as builder options or chain-method arguments)
- `WorkflowDefinitionOptions`
- `UnknownActivityNameWhenRegistryIsEmpty` (no longer needed; activity
  names are now typed through the builder's `.activities({...})` step)

Removed global module augmentation:

- `interface ActivityTypes` in `weft` (use the per-workflow
  `.activities({...})` chain method to type activity names instead).
  The matching `ctx.run<TName extends keyof ActivityTypes>` overload
  on `WorkflowContext` is also removed.
- `weft codegen` no longer emits an `ActivityTypes` block; activity
  typing now lives on each builder definition. The emitted
  `WorkflowRegistry` block is unchanged.

### Migration — Phase 6C builder cleanup

Replace each call site with the chained builder form:

```ts
// Before — bare async generator
engine.register('greet', async function* (ctx, input) {
  return `hello ${input}`;
});

// After
engine.register(
  workflow({ name: 'greet' }).execute(async function* (ctx, input) {
    return `hello ${input}`;
  }),
);
```

```ts
// Before — object form with metadata
engine.register('checkout', {
  version: '2.0',
  description: 'Runs checkout for an order.',
  tags: ['orders'],
  inputSchema,
  outputSchema,
  searchAttributes: { customerId: { type: 'string' } },
  handler,
});

// After — non-`searchAttributes` fields stay in options; that field
// moves to a chain method.
engine.register(
  workflow({
    name: 'checkout',
    version: '2.0',
    description: 'Runs checkout for an order.',
    tags: ['orders'],
    inputSchema,
    outputSchema,
  })
    .searchAttributes({ customerId: { type: 'string' } })
    .execute(handler),
);
```

```ts
// Before — global ActivityTypes augmentation
declare module 'weft' {
  interface ActivityTypes {
    formatGreeting: { args: [string]; result: string };
  }
}
engine.register('welcome', async function* (ctx, input: string) {
  return yield* ctx.run<'formatGreeting'>('formatGreeting', input);
});

// After — per-workflow activity typing on the builder
const welcome = workflow({ name: 'welcome' })
  .activities({
    formatGreeting: async (name: string) => `Hello, ${name}!`,
  })
  .execute(async function* (ctx, input: string) {
    return yield* ctx.run('formatGreeting', input);
  });
engine.register(welcome);
```

## [0.2.1] - 2026-06-03

### Changed

- Tightened the release-version verification path so `package.json`, the
  exported `VERSION`, and discovery-document defaults stay aligned before
  publishing.
- Folded first real integrator feedback into the package and documentation
  surface.
- Restored deterministic coverage and package validation gates for the release
  line.

### Breaking Changes

No breaking changes were introduced in `0.2.1`.

## [0.1.0] - 2026-05-11

### Removed (breaking)

Weft no longer ships an AI agent surface. All agent loops, declarations, and
coordination primitives now live outside Weft — in an external agent
framework or in your own loop on top of `ctx.run()` and `ctx.review()`.

Removed exports:

- `executeAgentLoop`, `AgentLoopSuspendedError`
- `AgentOptions`, `AgentResult`, `AgentTool`, `PendingProviderResumeState`,
  `PersistedAgentLoopState`, `TurnUsageEntry`, `VerificationRecorder`
- `AgentBureauConversationHistory`, `ChatOptions`, `ChatResponse`,
  `ChatResumeContext`, `ChatResumeHint`, `ConversationHistoryMessage`,
  `LLMProvider`, `NormalizedChatResponse`
- `ToolCall`, `ToolCallInput`, `ToolDefinition`, `ToolDescriptor`,
  `ToolResult`, `ToolResultInput`, `ToolErrorShape`, `ToolActionShape`,
  `ToolErrorCategory`, `TokenUsage`
- `debate`, `handoff`, `supervise`, `createChildHeaders`
- `agent`, `isAgentDefinition`, `AgentDefinition`, `AgentToolDefinition`,
  `ToolIdentityResult`, `AgentRegistrationOptions`
- `AgentTurnStartedEvent`, `AgentTurnCompletedEvent`, `AgentToolCalledEvent`,
  `AgentToolReturnedEvent`, `AgentCheckpointResumedEvent`,
  `AgentCheckpointSizeWarningEvent`, `WeftAgentEventMap`
- `Message`, `MessageRole`, `ConversationHistory`
- `ctx.agent()`, `ctx.handoff()`, `ctx.debate()`, `ctx.supervise()` removed
  from `Context`

### Renamed (breaking)

The following generic primitives were promoted out of `src/ai/` and renamed:

- `ToolEffectLog` → `EffectLog` (class)
- `ToolCallReplayConflictError` → `EffectReplayConflictError`
- `EffectLog` constructor parameter `agentId` → `operationId`
- `EffectRecord.toolName` → `EffectRecord.effectName` (no observed
  persisted-data impact — Phase 0 inventory found zero stored records with
  the field)
- `HumanReviewRequestedEvent` → `ReviewRequestedEvent` (TypeScript symbol only)
- `HumanReviewCompletedEvent` → `ReviewCompletedEvent` (TypeScript symbol only)
- `WeftAgentEventMap` → `WeftReviewEventMap`
- `ctx.humanReview()` → `ctx.review()`
- `HumanReviewOptions.conversation` field removed

### Wire format

Persisted event `type` strings remain unchanged: `'human-review:requested'`
and `'human-review:completed'`. Historical event records replay without
migration.

### Migration

Weft now focuses on durable execution and human-in-the-loop review. If you
were using Weft's agent loop or coordination primitives, migrate to an
external agent framework or build your loop on top of `ctx.run()` and
`ctx.review()`.

---

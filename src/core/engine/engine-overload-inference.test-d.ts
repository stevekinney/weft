// Call-site inference oracle for the Engine overload families a class split
// might disturb — schedule (both overloads) and the bulk dry-run-vs-commit
// return-type discrimination — plus a semantic-export guard for the
// module-level `assertCompatiblePersistedDataVersion` helper (exported from
// this module and consumed by `Engine.create`; a relocation must preserve its
// exact signature). Type-only: no runtime assertions.
//
// The whole-`.d.ts` public-surface gate already protects the emitted class
// block byte-for-byte; these assertions give the failure a *readable* call-site
// shape so a regression points at the offending overload, not just a diff.

import type { Storage as WeftStorage } from '../../storage/interface.ts';
import type {
  BulkCancelResult,
  BulkOperationCommitOptions,
  BulkOperationDryRunOptions,
  BulkOperationDryRunResult,
  ListFilter,
  ScheduleDefinition,
} from '../types.ts';
import { assertCompatiblePersistedDataVersion, Engine, ScheduleHandle } from './index.ts';

declare const engine: Engine;

// ---- schedule: definition overload --------------------------------------
declare const scheduleDefinition: ScheduleDefinition<{ id: number }>;
const fromDefinition: Promise<ScheduleHandle> = engine.schedule(scheduleDefinition);
void fromDefinition;

// ---- schedule: positional overload --------------------------------------
const fromPositional: Promise<ScheduleHandle> = engine.schedule('welcome', { id: 1 }, '0 * * * *');
void fromPositional;

// ---- bulk: dry-run overload returns the dry-run result -------------------
declare const filter: ListFilter;
declare const dryRunOptions: BulkOperationDryRunOptions;
const dryRun: Promise<BulkOperationDryRunResult> = engine.cancelAll(filter, dryRunOptions);
void dryRun;

// ---- bulk: commit overload returns the commit result ---------------------
declare const commitOptions: BulkOperationCommitOptions;
const commit: Promise<BulkCancelResult> = engine.cancelAll(filter, commitOptions);
void commit;

// The dry-run return type must NOT be assignable to the commit result — the two
// overloads exist precisely to give distinct call-site types. Read this together
// with the positive `dryRun` assertion above: if the overloads ever collapsed
// into a single signature returning the union, BOTH would error together (the
// union is not assignable to either narrow type), so a both-fail signals the
// overload split was lost rather than a mere assignment mistake.
// @ts-expect-error: a dry-run result is not a BulkCancelResult.
const mismatched: Promise<BulkCancelResult> = engine.cancelAll(filter, dryRunOptions);
void mismatched;

// ---- assertCompatiblePersistedDataVersion semantic export ----------------
// Exact signature: (storage) => Promise<void>. The schema-version gate is
// unconditional; there is no opt-out option.
declare const storage: WeftStorage;
const assertResult: Promise<void> = assertCompatiblePersistedDataVersion(storage);
void assertResult;

// ---- Engine.create startScheduler option (#590) --------------------------
// `startScheduler` arms the durable-timer poller independently of `recover`, so
// a host that owns its own recovery (recover:false) can still run timers, and a
// host that ticks deterministically can opt out while recovery runs.
const createdWithStartScheduler: Promise<Engine> = Engine.create({
  recover: false,
  startScheduler: true,
});
void createdWithStartScheduler;

const createdWithoutScheduler: Promise<Engine> = Engine.create({
  recover: true,
  startScheduler: false,
});
void createdWithoutScheduler;
// @ts-expect-error: the gate takes no options argument — there is no opt-out.
const assertRejectsOptions: Promise<void> = assertCompatiblePersistedDataVersion(storage, {});
void assertRejectsOptions;

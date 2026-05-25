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
import { ScheduleHandle } from './handles.ts';
import { assertCompatiblePersistedDataVersion, Engine } from './index.ts';

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
// overloads exist precisely to give distinct call-site types.
// @ts-expect-error: a dry-run result is not a BulkCancelResult.
const mismatched: Promise<BulkCancelResult> = engine.cancelAll(filter, dryRunOptions);
void mismatched;

// ---- assertCompatiblePersistedDataVersion semantic export ----------------
// Exact signature: (storage, options?: { allowLegacyData?: boolean }) => Promise<void>.
declare const storage: WeftStorage;
const assertResult: Promise<void> = assertCompatiblePersistedDataVersion(storage, {
  allowLegacyData: true,
});
void assertResult;
const assertNoOptions: Promise<void> = assertCompatiblePersistedDataVersion(storage);
void assertNoOptions;

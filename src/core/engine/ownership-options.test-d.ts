/**
 * Type-level pin for the public `ownership` option surface (ADR 0002). Fails to
 * typecheck if a refactor narrows the `ownership` union back to two members,
 * drops `workflowClaimTtl`/`workflowClaimRenewInterval`, or loosens either
 * field's type away from `Duration`.
 */
import { MemoryStorage } from '../../storage/memory.ts';
import { Engine } from './index.ts';

// `ownership: 'workflow-lease'` is accepted on its own …
const workflowLeaseEngine = new Engine({
  storage: new MemoryStorage(),
  ownership: 'workflow-lease',
});
void workflowLeaseEngine;

// … and together with both new tuning fields, each accepting both `Duration`
// forms (milliseconds as a number, or a duration string).
const tunedWorkflowLeaseEngine = new Engine({
  storage: new MemoryStorage(),
  ownership: 'workflow-lease',
  workflowClaimTtl: 30_000,
  workflowClaimRenewInterval: '5s',
});
void tunedWorkflowLeaseEngine;

// The pre-existing two members still type-check unchanged.
const noneEngine = new Engine({ storage: new MemoryStorage(), ownership: 'none' });
void noneEngine;
const leaseEngine = new Engine({
  storage: new MemoryStorage(),
  ownership: 'lease',
  leaseTtl: '30s',
  leaseRenewInterval: '5s',
  leaseWaitTimeout: '60s',
});
void leaseEngine;

const unknownOwnershipEngine = new Engine({
  storage: new MemoryStorage(),
  // @ts-expect-error ownership only accepts 'none' | 'lease' | 'workflow-lease'.
  ownership: 'workflow-leases',
});
void unknownOwnershipEngine;

const invalidClaimTtlEngine = new Engine({
  storage: new MemoryStorage(),
  ownership: 'workflow-lease',
  // @ts-expect-error workflowClaimTtl is a Duration (number | string), not a boolean.
  workflowClaimTtl: true,
});
void invalidClaimTtlEngine;

const invalidClaimRenewIntervalEngine = new Engine({
  storage: new MemoryStorage(),
  ownership: 'workflow-lease',
  // @ts-expect-error workflowClaimRenewInterval is a Duration (number | string), not a boolean.
  workflowClaimRenewInterval: true,
});
void invalidClaimRenewIntervalEngine;

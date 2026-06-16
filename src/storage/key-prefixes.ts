/**
 * Prefixes reserved for Weft-owned runtime data in a shared storage backend.
 *
 * Application state should live under an application namespace instead, for
 * example `scopedStorage(base, 'app:my-service')` or keys beginning with
 * `app:my-service:`. Treat this list as a stable keyspace contract: Weft may
 * add new reserved prefixes, but application code should not write under the
 * prefixes listed here.
 *
 * @example
 * ```ts
 * import { WEFT_RESERVED_KEY_PREFIXES } from '@lostgradient/weft/storage';
 *
 * const key = 'wf:order-123';
 * const isWeftKey = WEFT_RESERVED_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
 * console.log(isWeftKey); // true
 * ```
 */
export const WEFT_RESERVED_KEY_PREFIXES = [
  'actrec:',
  'archive:',
  'async-act:',
  'attr:',
  'audit:bulk:',
  'blob:',
  'budget:',
  'budget-charged:',
  'ev:',
  'fleet-event:',
  'idx:',
  'lease:',
  'liveness:',
  'offload:',
  'op:',
  'review:',
  'schedule:',
  'schedule-due:',
  'schedule-run:',
  'sig:',
  'sigres:',
  'sigseq:',
  'start-idem:',
  'state:',
  'tag:',
  'tool-effect:',
  'upd:',
  'upk:',
  'upr:',
  'wf:',
  'wf-cleanup:',
  'wf-cleanup-needed:',
  'wf-concurrency:',
  'wf-concurrency-holder:',
  'wf-deadline:',
  'wf-delayed:',
  'wf-finalizer-state:',
  'wf-has-services:',
  'wf-headers:',
  'wf-idx-',
  'wf-teardown:',
  'wf-teardown-deadletter:',
  'wf-teardown-needed:',
  'wf-terminal:',
] as const;

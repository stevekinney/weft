/**
 * Weft's keyspace: every key family Weft writes to a storage backend, gathered into `KEYS`, with the
 * default scope and the prefixes Weft reserves. The storage protocol itself lives in
 * `@lostgradient/storage`; nothing here re-exports it.
 *
 * @module storage/keys
 */
import { WORKFLOW_CATALOG_KEYS } from './catalog-keys.ts';
import { GENERATION_KEYS } from './generation-keys.ts';
import { LEASE_KEYS } from './lease-keys.ts';
import { WORKFLOW_LOG_KEYS } from './log-keys.ts';
import { MAILBOX_KEYS } from './mailbox-keys.ts';
import { OUTBOX_KEYS } from './outbox-keys.ts';
import { OWNERSHIP_CLAIM_KEYS } from './ownership-keys.ts';
import { SIGNAL_KEYS } from './signal-keys.ts';
import {
  WORKFLOW_LIFECYCLE_KEYS_CORE,
  WORKFLOW_LIFECYCLE_KEYS_EXTENDED,
} from './workflow-lifecycle-keys.ts';
import {
  WORKFLOW_RECORD_KEYS_CORE,
  WORKFLOW_RECORD_KEYS_EXTENDED,
} from './workflow-record-keys.ts';
export { WORKFLOW_CATALOG_KEYS } from './catalog-keys.ts';
export { DEFAULT_SCOPE } from './default-scope.ts';
export { GENERATION_KEYS } from './generation-keys.ts';
export { WEFT_RESERVED_KEY_PREFIXES } from './key-prefixes.ts';
export { LEASE_KEYS } from './lease-keys.ts';
export { WORKFLOW_LOG_KEYS } from './log-keys.ts';
export { MAILBOX_KEYS } from './mailbox-keys.ts';
export { OUTBOX_KEYS } from './outbox-keys.ts';
export { OWNERSHIP_CLAIM_KEYS } from './ownership-keys.ts';
export { SIGNAL_KEYS } from './signal-keys.ts';
export {
  WORKFLOW_LIFECYCLE_KEYS_CORE,
  WORKFLOW_LIFECYCLE_KEYS_EXTENDED,
} from './workflow-lifecycle-keys.ts';
export {
  WORKFLOW_RECORD_KEYS_CORE,
  WORKFLOW_RECORD_KEYS_EXTENDED,
} from './workflow-record-keys.ts';

/**
 * Key layout constants for hierarchical key encoding. Timestamps are
 * zero-padded to 16 digits for lexicographic ordering.
 *
 * The registry itself is assembled from feature-specific modules — `KEYS` is
 * the spread merge of the workflow record, lifecycle, signal, lease, mailbox,
 * outbox, ownership, and catalog key modules — so this file stays under the
 * repository's default 500-line ceiling (WFT-90). Prefer adding a new key
 * family as its own module spread into `KEYS` (see `ownership-keys.ts`) over
 * growing this file directly.
 *
 * `KEYS` is typed as an explicit intersection of each source module's own
 * `typeof` type rather than left to plain spread inference: TypeScript's
 * declaration emit does not propagate per-member JSDoc through an inferred
 * spread type, so hovering `KEYS.scheduleRunLink` would otherwise lose the
 * documentation on `scheduleRunLink` itself. The intersection keeps each
 * module's per-member docs as the single source of truth while still
 * surfacing them through `KEYS`.
 *
 * @example
 * ```ts
 * import { KEYS } from '@lostgradient/weft';
 * KEYS.workflow('workflow-id');
 * ```
 */
// This interleaving preserves the byte-identical Object.keys(KEYS) insertion
// order from before the module split (see interface.test.ts's characterization
// test): each *_CORE / *_EXTENDED pair is split at the point where another
// module's keys were interleaved in the original single-object literal.
export const KEYS: typeof WORKFLOW_RECORD_KEYS_CORE &
  typeof SIGNAL_KEYS &
  typeof WORKFLOW_LIFECYCLE_KEYS_CORE &
  typeof WORKFLOW_RECORD_KEYS_EXTENDED &
  typeof LEASE_KEYS &
  typeof MAILBOX_KEYS &
  typeof OUTBOX_KEYS &
  typeof OWNERSHIP_CLAIM_KEYS &
  typeof WORKFLOW_CATALOG_KEYS &
  typeof GENERATION_KEYS &
  typeof WORKFLOW_LOG_KEYS &
  typeof WORKFLOW_LIFECYCLE_KEYS_EXTENDED = {
  ...WORKFLOW_RECORD_KEYS_CORE,
  ...SIGNAL_KEYS,
  ...WORKFLOW_LIFECYCLE_KEYS_CORE,
  ...WORKFLOW_RECORD_KEYS_EXTENDED,
  ...LEASE_KEYS,
  ...MAILBOX_KEYS,
  ...OUTBOX_KEYS,
  ...OWNERSHIP_CLAIM_KEYS,
  ...WORKFLOW_CATALOG_KEYS,
  ...GENERATION_KEYS,
  ...WORKFLOW_LOG_KEYS,
  ...WORKFLOW_LIFECYCLE_KEYS_EXTENDED,
};

/**
 * `registerSource()` — the synchronous entry point for a dynamic workflow
 * source (WFT-13/14). Mirrors `engine.register()`'s own "stays synchronous,
 * defers the real work" contract: this records a catalog candidate keyed
 * `(name, revision)` and returns — it never invokes the source's loader and
 * never touches storage. The loader runs only inside a later, explicit
 * `resolveWorkflowSource()` call (`source-resolution.ts`).
 *
 * @module core/engine/source-registration
 */

import { utf8ByteLength } from '../../worker/manifest/utf8.ts';
import { MAX_CONTRACT_IDENTIFIER_BYTES } from '../contract/limits.ts';
import type { WorkflowSourceHandle } from '../source/index.ts';
import { validateWorkflowOrActivityName } from '../types/name-grammar.ts';
import type { EngineInternals } from './internals.ts';

/**
 * Cheap, structural well-formedness check on `source.descriptor` — no
 * storage, no `crypto.subtle`, no loader invocation. Rejects a
 * manually-constructed handle (bypassing `workflowSource()`'s typed
 * surface) whose `kind`/`name`/`revision` are missing, not non-empty
 * strings, or (for `revision`) exceed the same
 * `MAX_CONTRACT_IDENTIFIER_BYTES` bound `buildWorkflowRevisionManifest()`
 * enforces on a caller-supplied `options.revision` — `descriptor.revision`
 * is otherwise unbounded hostile input, since (per decision 3 in this
 * batch's spec) it is compared against, never fed into, a real manifest
 * build, so it never passes through that bound any other way. `name` is
 * bounded by {@link validateWorkflowOrActivityName} below instead — the same
 * grammar `engine.register()` already applies, with no separate length cap
 * of its own, so a source name is exactly as bounded as an eager one.
 */
function assertWellFormedSourceDescriptor(source: WorkflowSourceHandle): void {
  const { kind, name, revision } = source.descriptor;
  if (typeof kind !== 'string' || kind.length === 0) {
    throw new TypeError('registerSource(): source.descriptor.kind must be a non-empty string');
  }
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('registerSource(): source.descriptor.name must be a non-empty string');
  }
  if (typeof revision !== 'string' || revision.length === 0) {
    throw new TypeError('registerSource(): source.descriptor.revision must be a non-empty string');
  }
  const revisionBytes = utf8ByteLength(revision);
  if (revisionBytes > MAX_CONTRACT_IDENTIFIER_BYTES) {
    throw new TypeError(
      `registerSource(): source.descriptor.revision is ${revisionBytes} bytes, exceeding the maximum identifier size of ${MAX_CONTRACT_IDENTIFIER_BYTES}`,
    );
  }
}

/**
 * Record `source` as a lazily-resolvable candidate for
 * `(source.descriptor.name, source.descriptor.revision)`. Synchronous and
 * side-effect-free beyond the in-memory record: never invokes
 * `source.load`, never reads or writes storage.
 *
 * Collision rules, checked in both directions against `engine.register()`'s
 * own state so a workflow name can never be simultaneously eager and lazy:
 *
 * - A name already eagerly registered (`internals.registrations` — set by
 *   BOTH branches of `engine.register()`, unlike `workflowDefinitionsByName`,
 *   which only the builder-produced branch populates; checking that narrower
 *   map here would let a plain `{ name, handler }` `WorkflowDefinition`
 *   registered via `engine.register()` collide silently with a same-named
 *   `registerSource()` call) cannot also be registered as a source — throws.
 * - Re-registering the identical `source` object reference for the same
 *   `(name, revision)` is idempotent (a no-op), mirroring `engine.register()`'s
 *   own same-reference-is-idempotent rule for eager definitions.
 * - Registering a *different* handle under the same `(name, revision)` key
 *   throws — a revision identity, once claimed, names exactly one source.
 * - Multiple *different* revisions of the same lazy name may coexist
 *   unregistered — this is the direct lazy analog of the catalog already
 *   supporting multiple installed revisions per name (WFT-9/10); nothing in
 *   this batch's acceptance criteria forbids it.
 *
 * The symmetric check — an eager `engine.register()` call for a name
 * already claimed by a source — lives in `registration.ts`'s
 * `commitWorkflowDefinition`.
 */
export function registerSource(internals: EngineInternals, source: WorkflowSourceHandle): void {
  assertWellFormedSourceDescriptor(source);
  const { name, revision } = source.descriptor;
  validateWorkflowOrActivityName(name, 'workflow');

  // `workflowSource()` already returns a frozen descriptor, so this is a
  // no-op for every handle built through the typed surface. It is NOT a
  // no-op for a manually-constructed handle (bypassing that surface, same
  // class of input `assertWellFormedSourceDescriptor` above already
  // defends against) whose `descriptor` is a plain mutable object —
  // `WorkflowSourceDescriptor`'s `readonly` fields are compile-time only,
  // so nothing stops such a caller from mutating `descriptor.name`/
  // `revision` AFTER this call returns. Without this freeze, this map would
  // still index the ORIGINAL `(name, revision)` computed just above while
  // `resolveWorkflowSource()` later reads the live, mutated descriptor off
  // the same stored reference — installing an entirely different
  // workflow/revision under this key. Freezing here closes that gap while
  // preserving reference identity (`source` itself, and this stored
  // `Map` entry, are still the exact object the caller passed in — only its
  // `descriptor` becomes immutable), so the existing
  // same-reference-is-idempotent rule below is unaffected.
  Object.freeze(source.descriptor);

  if (internals.registrations.has(name)) {
    throw new Error(
      `Cannot registerSource("${name}"): "${name}" is already registered as an eager workflow ` +
        'via engine.register(). A workflow name may not be both eagerly registered and a dynamic source.',
    );
  }

  let byRevision = internals.workflowSourcesByName.get(name);
  if (byRevision === undefined) {
    byRevision = new Map();
    internals.workflowSourcesByName.set(name, byRevision);
  }

  const existing = byRevision.get(revision);
  if (existing === undefined) {
    byRevision.set(revision, source);
    return;
  }
  if (existing === source) {
    return;
  }
  throw new Error(
    `Cannot registerSource("${name}", "${revision}"): a different source handle is already ` +
      'registered for this exact (name, revision) key.',
  );
}

/**
 * Encoding, decoding, and structural validation for durable catalog records.
 *
 * The active-pointer record (`catalog-active:<name>`) is the only catalog
 * value whose bytes are read back and trusted for control-flow decisions
 * (the CAS retry loop, generation comparisons) — so unlike the manifest
 * entry (validated end-to-end by {@link parseWorkflowRevisionManifest}),
 * it gets its own small structural validator here rather than round-tripping
 * through a JSON-Schema-shaped parser.
 *
 * @module core/catalog/codec
 */

import { decode, encode } from '../codec.ts';
import { canonicalWorkflowContractJson } from '../contract/normalize.ts';
import type { WorkflowRevisionManifest } from '../contract/types.ts';
import type { WorkflowCatalogActivePointer } from './types.ts';

/** Encode an active-pointer record for durable storage. */
export function encodeActivePointer(pointer: WorkflowCatalogActivePointer): Uint8Array {
  return encode(pointer);
}

/**
 * Decode and structurally validate an active-pointer record read from
 * durable storage. Returns `null` when the bytes do not decode as a valid
 * `{ revision, generation, activatedAt }` record — the caller
 * (`restoreWorkflowCatalog`) fails closed on `null` rather than treating it
 * as absent, matching the codebase's fail-closed convention for corrupted
 * durable singleton records (`ownership-mode-marker.ts`,
 * `EngineLeaseCorruptedError`).
 */
export function decodeActivePointer(bytes: Uint8Array): WorkflowCatalogActivePointer | null {
  let decoded: unknown;
  try {
    decoded = decode(bytes);
  } catch {
    return null;
  }
  if (typeof decoded !== 'object' || decoded === null) return null;
  return validateActivePointerRecord(decoded as Record<string, unknown>);
}

/** Structural field-by-field validation, split out to keep {@link decodeActivePointer}'s complexity low. */
function validateActivePointerRecord(
  record: Record<string, unknown>,
): WorkflowCatalogActivePointer | null {
  const { revision, generation, activatedAt } = record;
  if (!isNonEmptyString(revision)) return null;
  if (!isPositiveSafeInteger(generation)) return null;
  if (typeof activatedAt !== 'number' || !Number.isFinite(activatedAt)) return null;
  return { revision, generation, activatedAt };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/**
 * Deep-equality comparison between two workflow revision manifests, used by
 * `WorkflowCatalog.install()` to decide whether a re-install for an existing
 * `(name, revision)` key is a byte-identical no-op or a genuine metadata
 * conflict. Compares each manifest's top-level identity scalars alongside
 * its `contract` field's existing canonical serialization
 * ({@link canonicalWorkflowContractJson}, `core/contract/normalize.ts`) —
 * reusing that canonicalizer rather than a fresh `JSON.stringify` keeps this
 * comparison immune to incidental object-key insertion-order differences
 * inside `contract`, the same guarantee `contractHash()`/`revision` already
 * rely on. A caller-supplied `revision` string that changed independently of
 * contract content is also treated as a conflict, not a silent no-op.
 */
export function manifestsAreByteIdentical(
  a: WorkflowRevisionManifest,
  b: WorkflowRevisionManifest,
): boolean {
  return canonicalManifestJson(a) === canonicalManifestJson(b);
}

function canonicalManifestJson(manifest: WorkflowRevisionManifest): string {
  return JSON.stringify({
    manifestVersion: manifest.manifestVersion,
    name: manifest.name,
    workflowVersion: manifest.workflowVersion,
    revision: manifest.revision,
    contractHash: manifest.contractHash,
    contract: canonicalWorkflowContractJson(manifest.contract),
  });
}

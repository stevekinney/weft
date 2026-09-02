/**
 * Hostile-input parsing for workflow revision manifests.
 *
 * A manifest arrives from a source this module does not control — persisted
 * storage read by an older or differently-configured build, a wire payload,
 * an operator-supplied fixture. Every field is proven from `unknown` rather
 * than asserted, every open-ended collection is bounded before it is walked,
 * and `contractHash` is always recomputed and compared rather than trusted
 * as supplied — a caller cannot assert a hash it did not earn.
 *
 * @module core/contract/manifest-parse
 */

import { isRecord } from '../../worker/manifest/is-record.ts';
import { utf8ByteLength } from '../../worker/manifest/utf8.ts';
import {
  workflowRevisionManifestFailure,
  type WorkflowRevisionManifestValidationFailure,
} from './failure.ts';
import { contractHash } from './hash.ts';
import { MAX_CONTRACT_IDENTIFIER_BYTES, MAX_NORMALIZED_CONTRACT_BYTES } from './limits.ts';
import { checkContractKey, parseContractRecord, parseSchemaPair } from './manifest-parse-schema.ts';
import { canonicalWorkflowContractJson, normalizeWorkflowContract } from './normalize.ts';
import type {
  WorkflowActivityContract,
  WorkflowContract,
  WorkflowMessageContract,
  WorkflowRevisionManifest,
} from './types.ts';
import { WORKFLOW_REVISION_MANIFEST_VERSION } from './types.ts';

/**
 * A successfully validated manifest, paired with the canonical serialization
 * of its (normalized) contract, so a caller does not have to re-derive it.
 *
 * @example
 * ```ts
 * import {
 *   buildWorkflowContract,
 *   buildWorkflowRevisionManifest,
 *   parseWorkflowRevisionManifest,
 *   type WorkflowRevisionManifestParseSuccess,
 * } from '@lostgradient/weft';
 *
 * const manifest = await buildWorkflowRevisionManifest(buildWorkflowContract({ name: 'checkout' }));
 * const result = await parseWorkflowRevisionManifest(manifest);
 * if (result.ok) {
 *   const accepted: WorkflowRevisionManifestParseSuccess = result;
 *   console.log(accepted.canonicalJson.length > 0);
 * }
 * ```
 */
export type WorkflowRevisionManifestParseSuccess = Readonly<{
  ok: true;
  /** The validated, normalized manifest. */
  manifest: WorkflowRevisionManifest;
  /** Canonical serialization of `manifest.contract` — `canonicalWorkflowContractJson(manifest.contract)`. */
  canonicalJson: string;
}>;

/**
 * Outcome of validating an untrusted workflow revision manifest.
 *
 * @example
 * ```ts
 * import { parseWorkflowRevisionManifest, type WorkflowRevisionManifestParseResult } from '@lostgradient/weft';
 *
 * const result: WorkflowRevisionManifestParseResult = await parseWorkflowRevisionManifest({});
 * console.log(result.ok);
 * ```
 */
export type WorkflowRevisionManifestParseResult =
  WorkflowRevisionManifestParseSuccess | WorkflowRevisionManifestValidationFailure;

type Outcome<T> = { ok: true; value: T } | WorkflowRevisionManifestValidationFailure;

function parseIdentifier(value: unknown, path: string): Outcome<string> {
  if (typeof value !== 'string' || value.length === 0) {
    return workflowRevisionManifestFailure('invalid-field', 'must be a non-empty string', path);
  }
  const bytes = utf8ByteLength(value);
  if (bytes > MAX_CONTRACT_IDENTIFIER_BYTES) {
    return workflowRevisionManifestFailure(
      'identifier-too-long',
      `is ${bytes} bytes, exceeding the maximum identifier size of ${MAX_CONTRACT_IDENTIFIER_BYTES}`,
      path,
    );
  }
  return { ok: true, value };
}

/**
 * Validate `description`: any string, including empty or longer than
 * `MAX_CONTRACT_IDENTIFIER_BYTES` — unlike `name`/`workflowVersion`/`revision`/
 * `contractHash`, `description` is free-form prose, not an identifier, and
 * `buildWorkflowContract()` imposes no length or non-emptiness constraint on
 * it. Bounded only by the overall `MAX_NORMALIZED_CONTRACT_BYTES` contract
 * size backstop, applied later in `finalizeManifest`.
 */
function parseDescription(value: unknown, path: string): Outcome<string> {
  if (typeof value !== 'string') {
    return workflowRevisionManifestFailure('invalid-field', 'must be a string', path);
  }
  return { ok: true, value };
}

/**
 * Validate one tag: any string, including empty or longer than
 * `MAX_CONTRACT_IDENTIFIER_BYTES` — like `description` (see
 * {@link parseDescription}), tags are free-form user-facing labels, not
 * wire identifiers. `WorkflowContractSource.tags` accepts any
 * `ReadonlyArray<string>` and `buildWorkflowContract()` imposes no
 * length or non-emptiness constraint on individual tags, so routing tags
 * through `parseIdentifier()` (which enforces both) would reject
 * producer-emitted manifests the builder itself considers valid. Bounded
 * only by the overall `MAX_NORMALIZED_CONTRACT_BYTES` contract size
 * backstop, applied later in `finalizeManifest`.
 */
function parseTag(value: unknown, path: string): Outcome<string> {
  if (typeof value !== 'string') {
    return workflowRevisionManifestFailure('invalid-field', 'must be a string', path);
  }
  return { ok: true, value };
}

function parseTags(value: unknown, path: string): Outcome<ReadonlyArray<string> | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(value)) {
    return workflowRevisionManifestFailure('invalid-field', 'must be an array of strings', path);
  }
  const tags: string[] = [];
  for (const [index, entry] of value.entries()) {
    const tag = parseTag(entry, `${path}[${index}]`);
    if (!tag.ok) return tag;
    tags.push(tag.value);
  }
  return { ok: true, value: tags.length === 0 ? undefined : tags };
}

type ContractIdentityFields = {
  name: string;
  workflowVersion: string;
  description?: string;
  tags?: ReadonlyArray<string>;
};

function parseContractIdentity(
  value: Readonly<Record<string, unknown>>,
  path: string,
): Outcome<ContractIdentityFields> {
  const name = parseIdentifier(value['name'], `${path}.name`);
  if (!name.ok) return name;
  const nameKeyFailure = checkContractKey(name.value, 'workflow', `${path}.name`);
  if (nameKeyFailure !== undefined) return nameKeyFailure;

  const workflowVersion = parseIdentifier(value['workflowVersion'], `${path}.workflowVersion`);
  if (!workflowVersion.ok) return workflowVersion;

  const identity: ContractIdentityFields = {
    name: name.value,
    workflowVersion: workflowVersion.value,
  };

  if (value['description'] !== undefined) {
    const description = parseDescription(value['description'], `${path}.description`);
    if (!description.ok) return description;
    identity.description = description.value;
  }

  const tags = parseTags(value['tags'], `${path}.tags`);
  if (!tags.ok) return tags;
  if (tags.value !== undefined) identity.tags = tags.value;

  return { ok: true, value: identity };
}

type ContractCollectionFields = {
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  signals?: Readonly<Record<string, WorkflowMessageContract>>;
  updates?: Readonly<Record<string, WorkflowMessageContract>>;
  queries?: Readonly<Record<string, WorkflowMessageContract>>;
  activities?: Readonly<Record<string, WorkflowActivityContract>>;
  finalizer?: WorkflowActivityContract;
};

/** `signals`/`updates`/`queries` accept any name; `activities` is grammar-validated, matching `checkContractKey`. */
const NAMED_RECORD_FIELDS = [
  ['signals', undefined],
  ['updates', undefined],
  ['queries', undefined],
  ['activities', 'activity'],
] as const;

function parseNamedRecordFields(
  value: Readonly<Record<string, unknown>>,
  path: string,
  collections: ContractCollectionFields,
): WorkflowRevisionManifestValidationFailure | undefined {
  for (const [field, keyKind] of NAMED_RECORD_FIELDS) {
    if (value[field] === undefined) continue;
    const parsed = parseContractRecord(value[field], `${path}.${field}`, keyKind);
    if (!parsed.ok) return parsed;
    collections[field] = parsed.value;
  }
  return undefined;
}

function parseContractCollections(
  value: Readonly<Record<string, unknown>>,
  path: string,
): Outcome<ContractCollectionFields> {
  const collections: ContractCollectionFields = {};

  if (value['inputSchema'] !== undefined || value['outputSchema'] !== undefined) {
    const pair = parseSchemaPair(
      { inputSchema: value['inputSchema'], outputSchema: value['outputSchema'] },
      path,
    );
    if (!pair.ok) return pair;
    if (pair.value.inputSchema !== undefined) collections.inputSchema = pair.value.inputSchema;
    if (pair.value.outputSchema !== undefined) collections.outputSchema = pair.value.outputSchema;
  }

  const recordFailure = parseNamedRecordFields(value, path, collections);
  if (recordFailure !== undefined) return recordFailure;

  if (value['finalizer'] !== undefined) {
    const finalizer = parseSchemaPair(value['finalizer'], `${path}.finalizer`);
    if (!finalizer.ok) return finalizer;
    collections.finalizer = finalizer.value;
  }

  return { ok: true, value: collections };
}

function parseContract(value: unknown, path: string): Outcome<WorkflowContract> {
  if (!isRecord(value)) {
    return workflowRevisionManifestFailure('invalid-field', 'must be a JSON object', path);
  }

  const identity = parseContractIdentity(value, path);
  if (!identity.ok) return identity;

  const collections = parseContractCollections(value, path);
  if (!collections.ok) return collections;

  return { ok: true, value: { ...identity.value, ...collections.value } };
}

type TopLevelIdentifiers = {
  name: string;
  workflowVersion: string;
  revision: string;
  contractHash: string;
};

const TOP_LEVEL_IDENTIFIER_FIELDS = [
  ['name', 'manifest.name'],
  ['workflowVersion', 'manifest.workflowVersion'],
  ['revision', 'manifest.revision'],
  ['contractHash', 'manifest.contractHash'],
] as const;

function parseTopLevelIdentifiers(
  value: Readonly<Record<string, unknown>>,
): Outcome<TopLevelIdentifiers> {
  const parsed: Partial<TopLevelIdentifiers> = {};
  for (const [field, path] of TOP_LEVEL_IDENTIFIER_FIELDS) {
    const result = parseIdentifier(value[field], path);
    if (!result.ok) return result;
    parsed[field] = result.value;
  }
  return { ok: true, value: parsed as TopLevelIdentifiers };
}

/** `manifest.name`/`manifest.workflowVersion` are redundant with `manifest.contract`'s own fields and must agree. */
function checkIdentityAgreement(
  identifiers: TopLevelIdentifiers,
  contract: WorkflowContract,
): WorkflowRevisionManifestValidationFailure | undefined {
  if (identifiers.name !== contract.name) {
    return workflowRevisionManifestFailure(
      'invalid-field',
      'must equal manifest.contract.name',
      'manifest.name',
    );
  }
  if (identifiers.workflowVersion !== contract.workflowVersion) {
    return workflowRevisionManifestFailure(
      'invalid-field',
      'must equal manifest.contract.workflowVersion',
      'manifest.workflowVersion',
    );
  }
  return undefined;
}

async function finalizeManifest(
  identifiers: TopLevelIdentifiers,
  normalized: WorkflowContract,
): Promise<WorkflowRevisionManifestParseResult> {
  // Every field above was rebuilt from proven parts, so nothing unknown can
  // survive into the manifest. Normalizing once more sorts the open-ended
  // records, which makes the returned value byte-equivalent to the
  // canonical form the caller will store and diff.
  const canonicalJson = canonicalWorkflowContractJson(normalized);
  const canonicalBytes = utf8ByteLength(canonicalJson);
  if (canonicalBytes > MAX_NORMALIZED_CONTRACT_BYTES) {
    return workflowRevisionManifestFailure(
      'manifest-too-large',
      `contract normalizes to ${canonicalBytes} bytes, exceeding the maximum of ${MAX_NORMALIZED_CONTRACT_BYTES}`,
      'manifest.contract',
    );
  }

  const recomputedHash = await contractHash(normalized);
  if (recomputedHash !== identifiers.contractHash) {
    return workflowRevisionManifestFailure(
      'contract-hash-mismatch',
      `recomputed contractHash ${recomputedHash} does not match the supplied value`,
      'manifest.contractHash',
    );
  }

  return {
    ok: true,
    manifest: {
      manifestVersion: WORKFLOW_REVISION_MANIFEST_VERSION,
      name: identifiers.name,
      workflowVersion: identifiers.workflowVersion,
      revision: identifiers.revision,
      contractHash: recomputedHash,
      contract: normalized,
    },
    canonicalJson,
  };
}

/**
 * Validate an untrusted workflow revision manifest.
 *
 * The returned manifest is already normalized, `contractHash` is always
 * recomputed from the (normalized) contract and compared against the
 * supplied value — a mismatch is rejected with `'contract-hash-mismatch'`
 * regardless of what the caller asserted — and `manifest.name`/
 * `manifest.workflowVersion` must agree with `manifest.contract.name`/
 * `manifest.contract.workflowVersion`. `revision` is validated (bounded,
 * non-empty) but never recomputed: it is an opaque label the parser trusts
 * once it is well-formed.
 *
 * @example
 * ```ts
 * import { buildWorkflowContract, buildWorkflowRevisionManifest, parseWorkflowRevisionManifest } from '@lostgradient/weft';
 *
 * const manifest = await buildWorkflowRevisionManifest(buildWorkflowContract({ name: 'checkout' }));
 * const result = await parseWorkflowRevisionManifest(manifest);
 * console.log(result.ok ? result.manifest.name : result.reason);
 * ```
 */
export async function parseWorkflowRevisionManifest(
  value: unknown,
): Promise<WorkflowRevisionManifestParseResult> {
  if (!isRecord(value)) {
    return workflowRevisionManifestFailure('not-an-object', 'manifest must be a JSON object');
  }

  // Version is checked before any other field so an unknown schema is
  // rejected rather than best-effort parsed against the shape we happen to
  // know.
  if (value['manifestVersion'] !== WORKFLOW_REVISION_MANIFEST_VERSION) {
    return workflowRevisionManifestFailure(
      'manifest-version-unsupported',
      `manifest.manifestVersion must be ${String(WORKFLOW_REVISION_MANIFEST_VERSION)}`,
    );
  }

  const identifiers = parseTopLevelIdentifiers(value);
  if (!identifiers.ok) return identifiers;

  const contract = parseContract(value['contract'], 'manifest.contract');
  if (!contract.ok) return contract;

  const agreementFailure = checkIdentityAgreement(identifiers.value, contract.value);
  if (agreementFailure !== undefined) return agreementFailure;

  const normalized = normalizeWorkflowContract(contract.value);
  return finalizeManifest(identifiers.value, normalized);
}

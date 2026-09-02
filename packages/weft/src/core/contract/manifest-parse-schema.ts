/**
 * Hostile-input validation for the schema-fragment-shaped parts of an
 * untrusted {@link WorkflowRevisionManifest}: `inputSchema`/`outputSchema`
 * pairs, and the `signals`/`updates`/`queries`/`activities` records that
 * carry them.
 *
 * Split out of `manifest-parse.ts` to keep each file under the repository's
 * implementation-file-size ceiling and so the depth/JSON-safety walk that
 * every schema fragment goes through has one place to audit.
 *
 * @module core/contract/manifest-parse-schema
 */

import { isRecord } from '../../worker/manifest/is-record.ts';
import { utf8ByteLength } from '../../worker/manifest/utf8.ts';
import { isJSONValue } from '../json.ts';
import { validateWorkflowOrActivityName, type NameKind } from '../types/name-grammar.ts';
import {
  workflowRevisionManifestFailure,
  type WorkflowRevisionManifestValidationFailure,
} from './failure.ts';
import {
  MAX_CONTRACT_IDENTIFIER_BYTES,
  MAX_CONTRACT_MESSAGE_COUNT,
  MAX_CONTRACT_SCHEMA_DEPTH,
} from './limits.ts';
import type { WorkflowActivityContract, WorkflowMessageContract } from './types.ts';

type ParseSuccess<T> = { ok: true; value: T };
type ParseOutcome<T> = ParseSuccess<T> | WorkflowRevisionManifestValidationFailure;

/**
 * Iteratively (never recursively, so adversarial nesting cannot exhaust the
 * call stack before any bound fires) check that a parsed JSON value nests no
 * deeper than `maxDepth`.
 */
function withinDepth(value: unknown, maxDepth: number): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    if (frame.depth > maxDepth) return false;
    const current = frame.value;
    if (current === null || typeof current !== 'object') continue;

    const nextDepth = frame.depth + 1;
    if (nextDepth > maxDepth) return false;

    if (Array.isArray(current)) {
      for (const item of current) stack.push({ value: item, depth: nextDepth });
    } else {
      for (const item of Object.values(current as Record<string, unknown>)) {
        stack.push({ value: item, depth: nextDepth });
      }
    }
  }
  return true;
}

/** Deep-clone a proven-JSON-safe value onto null-prototype objects. */
function cloneJsonSafe(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => cloneJsonSafe(entry));

  const record = value as Readonly<Record<string, unknown>>;
  const cloned: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    cloned[key] = cloneJsonSafe(record[key]);
  }
  return cloned;
}

/** Validate one `inputSchema`/`outputSchema` fragment from untrusted input. */
function parseSchemaFragment(value: unknown, path: string): ParseOutcome<Record<string, unknown>> {
  if (!isRecord(value)) {
    return workflowRevisionManifestFailure('invalid-field', 'must be a JSON object', path);
  }
  if (!withinDepth(value, MAX_CONTRACT_SCHEMA_DEPTH)) {
    return workflowRevisionManifestFailure(
      'invalid-field',
      `nests deeper than the maximum schema depth of ${MAX_CONTRACT_SCHEMA_DEPTH}`,
      path,
    );
  }
  if (!isJSONValue(value)) {
    return workflowRevisionManifestFailure('invalid-field', 'must be a JSON-safe object', path);
  }
  return { ok: true, value: cloneJsonSafe(value) as Record<string, unknown> };
}

/** Validate a `{ inputSchema?, outputSchema? }`-shaped entry from untrusted input. */
export function parseSchemaPair(
  value: unknown,
  path: string,
): ParseOutcome<WorkflowMessageContract | WorkflowActivityContract> {
  if (!isRecord(value)) {
    return workflowRevisionManifestFailure('invalid-field', 'must be a JSON object', path);
  }

  const entry: { inputSchema?: Record<string, unknown>; outputSchema?: Record<string, unknown> } =
    {};

  if (value['inputSchema'] !== undefined) {
    const inputSchema = parseSchemaFragment(value['inputSchema'], `${path}.inputSchema`);
    if (!inputSchema.ok) return inputSchema;
    entry.inputSchema = inputSchema.value;
  }
  if (value['outputSchema'] !== undefined) {
    const outputSchema = parseSchemaFragment(value['outputSchema'], `${path}.outputSchema`);
    if (!outputSchema.ok) return outputSchema;
    entry.outputSchema = outputSchema.value;
  }

  return { ok: true, value: entry };
}

/**
 * Validate one record key: present, non-empty, within the identifier byte
 * ceiling and, when `kind` is given, wire-safe per
 * `validateWorkflowOrActivityName`. Signal/update/query names pass `kind:
 * undefined` — those names are deliberately unconstrained, matching
 * `SignalDefinition`/`UpdateDefinition`/`QueryDefinition` at the type level.
 */
export function checkContractKey(
  key: string,
  kind: NameKind | undefined,
  path: string,
): WorkflowRevisionManifestValidationFailure | undefined {
  // An empty string is a wire-safe, engine-supported signal/update/query
  // name (see message-handles.ts's signal()/update()/query() — they impose
  // no length constraint on `name` at all), so the empty-string rejection
  // applies only to workflow/activity names (`kind !== undefined`); for
  // those, `validateWorkflowOrActivityName` below rejects it too (its
  // grammar requires at least one character), but checking here first keeps
  // the error message specific ("must not be an empty string" rather than
  // the grammar's generic pattern-mismatch message).
  if (kind !== undefined && key.length === 0) {
    return workflowRevisionManifestFailure('invalid-field', 'must not be an empty string', path);
  }
  // The `MAX_CONTRACT_IDENTIFIER_BYTES` length ceiling, like the emptiness
  // check above, applies only to workflow/activity names (`kind !==
  // undefined`). Signal/update/query names have no length limit at the type
  // level either — `signal()`/`update()`/`query()` in `message-handles.ts`
  // impose no length constraint on `name` — so applying it unconditionally
  // would reject a producer-emitted manifest for a message name the builder
  // itself accepts.
  if (kind !== undefined) {
    const bytes = utf8ByteLength(key);
    if (bytes > MAX_CONTRACT_IDENTIFIER_BYTES) {
      return workflowRevisionManifestFailure(
        'identifier-too-long',
        `is ${bytes} bytes, exceeding the maximum identifier size of ${MAX_CONTRACT_IDENTIFIER_BYTES}`,
        path,
      );
    }
    try {
      validateWorkflowOrActivityName(key, kind);
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : 'is not a wire-safe name';
      // `validateWorkflowOrActivityName`'s own message embeds the raw
      // offending name verbatim (see `types/name-grammar.ts`'s two `throw`
      // sites) — replace every literal occurrence with its JSON-escaped
      // form so a hostile `--from`/`--server` manifest's name containing a
      // newline or ANSI escape sequence can never inject itself into a
      // diagnostic a caller prints straight to a terminal
      // (`executeCodegen()`'s single-line stderr contract,
      // `cli/codegen-validate.ts`). `key` is guaranteed non-empty here (the
      // empty-string case returns above), so `replaceAll` cannot degenerate
      // into inserting between every character.
      const message = rawMessage.replaceAll(key, JSON.stringify(key));
      return workflowRevisionManifestFailure('invalid-field', message, path);
    }
  }
  return undefined;
}

/**
 * Validate a `signals`/`updates`/`queries`/`activities` record from
 * untrusted input: bounded entry count, bounded/validated keys, and every
 * entry parsed as a schema pair.
 */
export function parseContractRecord(
  value: unknown,
  path: string,
  keyKind: NameKind | undefined,
): ParseOutcome<Readonly<Record<string, WorkflowMessageContract | WorkflowActivityContract>>> {
  if (!isRecord(value)) {
    return workflowRevisionManifestFailure('invalid-field', 'must be a JSON object', path);
  }

  const names = Object.keys(value);
  if (names.length > MAX_CONTRACT_MESSAGE_COUNT) {
    return workflowRevisionManifestFailure(
      'too-many-entries',
      `declares ${names.length} entries, exceeding the maximum of ${MAX_CONTRACT_MESSAGE_COUNT}`,
      path,
    );
  }

  const built: Record<string, WorkflowMessageContract | WorkflowActivityContract> = Object.create(
    null,
  ) as Record<string, WorkflowMessageContract | WorkflowActivityContract>;
  for (const name of names) {
    const keyFailure = checkContractKey(name, keyKind, `${path} key ${JSON.stringify(name)}`);
    if (keyFailure !== undefined) return keyFailure;

    const entry = parseSchemaPair(value[name], `${path}.${name}`);
    if (!entry.ok) return entry;
    built[name] = entry.value;
  }

  return { ok: true, value: built };
}

/**
 * Shared validation and fault mapping for the five `weft.workflows.revisions.*`
 * / `weft.workflows.active.*` operations (WFT-11): `install-workflow-revision.ts`,
 * `activate-workflow-revision.ts`, `get-workflow-revision.ts`,
 * `list-workflow-revisions.ts`, `get-active-workflow-revision.ts`.
 *
 * @module server/operations/workflow-catalog-operation-helpers
 */

import { z } from 'zod';

import {
  WorkflowCatalogConflictError,
  WorkflowRevisionNotInstalledError,
  type WorkflowCatalogActivationResult,
} from '../../core/catalog/index.ts';
import type { WorkflowCompatibilityPolicy } from '../../core/contract/compatibility.ts';
import type { WorkflowRevisionManifestValidationFailure } from '../../core/contract/failure.ts';
import { MAX_CONTRACT_IDENTIFIER_BYTES } from '../../core/contract/limits.ts';
import { parseWorkflowRevisionManifest } from '../../core/contract/manifest-parse.ts';
import type { WorkflowRevisionManifest } from '../../core/contract/types.ts';
import { WorkflowNotRegisteredError } from '../../core/engine/errors.ts';
import { validateWorkflowOrActivityName } from '../../core/types/name-grammar.ts';
import type { AccessPolicy } from '../authorization.ts';
import type { OperationFault } from '../operation-fault.ts';
import type { RestInputContext } from '../rest-binding.ts';
import { readRestJsonBody } from '../rest-body.ts';
import { invalidParamsFault, isOperationFault } from './operation-helpers.ts';

/** `workflows:admin` — required by `install` and `activate` (mutating). */
export const workflowsAdminAccess: AccessPolicy = {
  kind: 'scoped',
  scopes: { kind: 'anyOf', scopes: ['workflows:admin'] },
};

/** `workflows:read` — required by `get`/`list`/`active.get` (read-only). */
export const workflowsReadAccess: AccessPolicy = {
  kind: 'scoped',
  scopes: { kind: 'anyOf', scopes: ['workflows:read'] },
};

/**
 * Validate one `name` field per the wire-safe name grammar, raising the
 * same `InvalidParams` fault both REST and JSON-RPC callers see for every
 * other malformed identifier in this operation family. Bounded by
 * `validateWorkflowOrActivityName` itself (`MAX_CONTRACT_IDENTIFIER_BYTES`).
 */
export function validateWorkflowNameField(name: unknown): string {
  if (typeof name !== 'string' || name.length === 0) {
    throw invalidParamsFault('Field "name" must be a non-empty string');
  }
  try {
    validateWorkflowOrActivityName(name, 'workflow');
  } catch (error) {
    throw invalidParamsFault(error instanceof Error ? error.message : String(error));
  }
  return name;
}

/** Validate one `revision` field: a non-empty, bounded opaque string. */
export function validateWorkflowRevisionField(revision: unknown): string {
  if (typeof revision !== 'string' || revision.length === 0) {
    throw invalidParamsFault('Field "revision" must be a non-empty string');
  }
  if (new TextEncoder().encode(revision).byteLength > MAX_CONTRACT_IDENTIFIER_BYTES) {
    throw invalidParamsFault(
      `Field "revision" exceeds the maximum identifier size of ${String(MAX_CONTRACT_IDENTIFIER_BYTES)} bytes`,
    );
  }
  return revision;
}

/** Validate an optional `expectedGeneration` field: a non-negative safe integer. */
export function validateExpectedGenerationField(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalidParamsFault('Field "expectedGeneration" must be a non-negative integer');
  }
  return value;
}

const compatibilityPolicyShape = z
  .object({ requireExactRevision: z.boolean().optional() })
  .strict();

/** Validate an optional `policy` field against the one tunable compatibility axis. */
export function validatePolicyField(value: unknown): WorkflowCompatibilityPolicy | undefined {
  if (value === undefined) return undefined;
  const parsed = compatibilityPolicyShape.safeParse(value);
  if (!parsed.success) {
    throw invalidParamsFault(
      'Field "policy" must be an object with an optional boolean "requireExactRevision"',
    );
  }
  return parsed.data.requireExactRevision === undefined
    ? {}
    : { requireExactRevision: parsed.data.requireExactRevision };
}

/**
 * Validate an untrusted `manifest` field via {@link parseWorkflowRevisionManifest} —
 * the same hostile-input validation path (bounded sizes, recomputed
 * `contractHash`) every other manifest consumer in this codebase uses.
 */
export async function validateManifestField(value: unknown): Promise<WorkflowRevisionManifest> {
  const result = await parseWorkflowRevisionManifest(value);
  if (!result.ok) {
    throw manifestValidationFailureFault(result);
  }
  return result.manifest;
}

function manifestValidationFailureFault(
  failure: WorkflowRevisionManifestValidationFailure,
): OperationFault {
  return {
    code: 'InvalidParams',
    message: failure.message,
    data: {
      issues: [
        {
          path: failure.path === undefined ? [] : failure.path.split('.'),
          message: failure.message,
          code: failure.reason,
        },
      ],
    },
  };
}

/**
 * Map one `applied: false` {@link WorkflowCatalogActivationResult} variant to
 * the canonical `Conflict` fault. Exhaustive over all four refusal reasons —
 * adding a fifth is a compile error here, forcing a deliberate wire mapping.
 */
export function activationRefusalToFault(
  result: Extract<WorkflowCatalogActivationResult, { applied: false }>,
): OperationFault {
  switch (result.reason) {
    case 'incompatible': {
      // `verdict`'s own type is the full `WorkflowCompatibilityVerdict` union
      // (not narrowed by `reason`), but `activateCandidate` only ever
      // constructs an `incompatible` result alongside `verdict.compatible ===
      // false` — see `workflow-catalog.ts`'s `#refuseIncompatibleOrStaleCandidate`.
      const { verdict } = result;
      const reasons = verdict.compatible ? [] : verdict.reasons;
      return {
        code: 'Conflict',
        message: `Candidate revision is incompatible with the currently active revision: ${reasons.join(', ')}`,
        data: { reason: result.reason, compatibilityReasons: reasons },
      };
    }
    case 'stale-generation':
      return {
        code: 'Conflict',
        message: `Stale expectedGeneration: the current durable generation is ${String(result.currentGeneration)}`,
        data: { reason: result.reason, currentGeneration: result.currentGeneration },
      };
    case 'expected-generation-required':
      return {
        code: 'Conflict',
        message:
          'expectedGeneration is required once a workflow has an active revision — current ' +
          `generation is ${String(result.currentGeneration)}`,
        data: { reason: result.reason, currentGeneration: result.currentGeneration },
      };
    case 'conflict':
      return {
        code: 'Conflict',
        message: 'Activation lost a concurrent write race; re-read the active pointer and retry',
        data: { reason: result.reason },
      };
    default: {
      const _exhaustive: never = result;
      throw new Error(`Unknown activation refusal reason: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/**
 * Map an error thrown by `engine.workflows.install()`/`activate()` to the
 * canonical operation fault, or rethrow unchanged when it is neither typed
 * error this family can produce (letting the operation pipeline's generic
 * `EngineFailure` wrapping handle anything else).
 */
export function throwWorkflowCatalogOperationFault(error: unknown): never {
  if (error instanceof WorkflowRevisionNotInstalledError) {
    const fault: OperationFault = {
      code: 'NotFound',
      message: error.message,
      data: {
        resource: 'workflow-revision',
        identifier: `${error.workflowName}:${error.revision}`,
        weftCode: error.code,
      },
    };
    throw fault;
  }
  if (error instanceof WorkflowNotRegisteredError) {
    throw invalidParamsFault(error.message, error.code);
  }
  if (error instanceof WorkflowCatalogConflictError) {
    const fault: OperationFault = {
      code: 'Conflict',
      message: error.message,
      data: { reason: 'catalog-conflict', weftCode: error.code },
    };
    throw fault;
  }
  throw error;
}

/**
 * Read a REST request body as a JSON object, raising `InvalidParams` for
 * malformed JSON or a non-object top-level value — shared by
 * `install-workflow-revision.ts` (body-only) and
 * `activate-workflow-revision.ts` (path `name` plus body fields).
 */
export async function readWorkflowCatalogRestBody(
  request: Request,
  context: RestInputContext,
): Promise<Record<string, unknown>> {
  const body = await readRestJsonBody(request, context).catch((error) => {
    if (isOperationFault(error)) throw error;
    return null;
  });
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalidParamsFault('Request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
}

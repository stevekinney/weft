/**
 * Direct unit tests for the shared validation/fault-mapping helpers behind
 * the five `weft.workflows.revisions.*` / `weft.workflows.active.*`
 * operations (WFT-11). The five operation test files exercise these
 * end-to-end through REST/JSON-RPC; this file targets branches (invalid
 * `policy`, the `conflict` refusal reason, the unknown-error rethrow
 * fallback, a malformed REST body) that are awkward or impossible to reach
 * from a single well-formed request.
 */

import { describe, expect, it } from 'bun:test';

import type { WorkflowCatalogActivationResult } from '../../core/catalog/index.ts';
import {
  WorkflowCatalogConflictError,
  WorkflowRevisionNotInstalledError,
} from '../../core/catalog/index.ts';
import { buildWorkflowContract } from '../../core/contract/build.ts';
import { buildWorkflowRevisionManifest } from '../../core/contract/manifest.ts';
import { WorkflowNotRegisteredError } from '../../core/engine/errors.ts';
import { isOperationFault } from './operation-helpers.ts';
import {
  activationRefusalToFault,
  readWorkflowCatalogRestBody,
  throwWorkflowCatalogOperationFault,
  validateExpectedGenerationField,
  validateManifestField,
  validatePolicyField,
  validateWorkflowNameField,
  validateWorkflowRevisionField,
} from './workflow-catalog-operation-helpers.ts';

describe('validateWorkflowNameField', () => {
  it('accepts a valid wire-safe name', () => {
    expect(validateWorkflowNameField('checkout')).toBe('checkout');
  });

  it('rejects a non-string value', () => {
    expect(() => validateWorkflowNameField(42)).toThrow();
  });

  it('rejects an empty string', () => {
    expect(() => validateWorkflowNameField('')).toThrow();
  });

  it('rejects a string that fails the wire-safe name grammar', () => {
    expect(() => validateWorkflowNameField('1starts-with-digit')).toThrow();
  });
});

describe('validateWorkflowRevisionField', () => {
  it('accepts a valid non-empty string', () => {
    expect(validateWorkflowRevisionField('r1')).toBe('r1');
  });

  it('rejects a non-string value', () => {
    expect(() => validateWorkflowRevisionField(null)).toThrow();
  });

  it('rejects an empty string', () => {
    expect(() => validateWorkflowRevisionField('')).toThrow();
  });

  it('rejects a revision exceeding the maximum identifier byte size', () => {
    expect(() => validateWorkflowRevisionField('r'.repeat(600))).toThrow();
  });
});

describe('validateExpectedGenerationField', () => {
  it('returns undefined for an omitted value', () => {
    expect(validateExpectedGenerationField(undefined)).toBeUndefined();
  });

  it('accepts a non-negative safe integer', () => {
    expect(validateExpectedGenerationField(3)).toBe(3);
  });

  it('rejects a negative value', () => {
    expect(() => validateExpectedGenerationField(-1)).toThrow();
  });

  it('rejects a non-integer value', () => {
    expect(() => validateExpectedGenerationField(1.5)).toThrow();
  });

  it('rejects a non-number value', () => {
    expect(() => validateExpectedGenerationField('1')).toThrow();
  });
});

describe('validatePolicyField', () => {
  it('returns undefined for an omitted value', () => {
    expect(validatePolicyField(undefined)).toBeUndefined();
  });

  it('accepts an empty object', () => {
    expect(validatePolicyField({})).toEqual({});
  });

  it('accepts requireExactRevision: false', () => {
    expect(validatePolicyField({ requireExactRevision: false })).toEqual({
      requireExactRevision: false,
    });
  });

  it('rejects a non-object value', () => {
    expect(() => validatePolicyField('not an object')).toThrow();
  });

  it('rejects an unknown key (strict schema)', () => {
    expect(() => validatePolicyField({ unknownKey: true })).toThrow();
  });

  it('rejects a non-boolean requireExactRevision', () => {
    expect(() => validatePolicyField({ requireExactRevision: 'yes' })).toThrow();
  });
});

describe('validateManifestField', () => {
  it('accepts and returns a valid manifest', async () => {
    const contract = buildWorkflowContract({ name: 'checkout', version: '1.0.0' });
    const manifest = await buildWorkflowRevisionManifest(contract);

    const result = await validateManifestField(manifest);

    expect(result.revision).toBe(manifest.revision);
  });

  it('rejects a non-object value with InvalidParams', async () => {
    await expect(validateManifestField('not an object')).rejects.toMatchObject({
      code: 'InvalidParams',
    });
  });

  it('rejects a manifest with a tampered contractHash', async () => {
    const contract = buildWorkflowContract({ name: 'checkout', version: '1.0.0' });
    const manifest = await buildWorkflowRevisionManifest(contract);
    const tampered = { ...manifest, contractHash: `${manifest.contractHash.slice(0, -1)}0` };

    await expect(validateManifestField(tampered)).rejects.toMatchObject({ code: 'InvalidParams' });
  });
});

describe('activationRefusalToFault', () => {
  it('maps incompatible to Conflict with compatibilityReasons', () => {
    const fault = activationRefusalToFault({
      applied: false,
      reason: 'incompatible',
      verdict: { compatible: false, reasons: ['contract-hash-mismatch'] },
    });

    expect(fault.code).toBe('Conflict');
    if (fault.code === 'Conflict') {
      expect(fault.data.compatibilityReasons).toEqual(['contract-hash-mismatch']);
    }
  });

  it('maps stale-generation to Conflict with currentGeneration', () => {
    const fault = activationRefusalToFault({
      applied: false,
      reason: 'stale-generation',
      currentGeneration: 5,
    });

    expect(fault.code).toBe('Conflict');
    if (fault.code === 'Conflict') {
      expect(fault.data.currentGeneration).toBe(5);
    }
  });

  it('maps expected-generation-required to Conflict with currentGeneration', () => {
    const fault = activationRefusalToFault({
      applied: false,
      reason: 'expected-generation-required',
      currentGeneration: 2,
    });

    expect(fault.code).toBe('Conflict');
    if (fault.code === 'Conflict') {
      expect(fault.data.currentGeneration).toBe(2);
      expect(fault.data.reason).toBe('expected-generation-required');
    }
  });

  it('maps conflict to Conflict with no extra fields', () => {
    const fault = activationRefusalToFault({ applied: false, reason: 'conflict' });

    expect(fault.code).toBe('Conflict');
    if (fault.code === 'Conflict') {
      expect(fault.data.reason).toBe('conflict');
      expect(fault.data.currentGeneration).toBeUndefined();
      expect(fault.data.compatibilityReasons).toBeUndefined();
    }
  });

  it('throws on an unrecognized reason (exhaustiveness guard, unreachable through the public type)', () => {
    const bogus = {
      applied: false,
      reason: 'not-a-real-reason',
    } as unknown as Extract<WorkflowCatalogActivationResult, { applied: false }>;

    expect(() => activationRefusalToFault(bogus)).toThrow(/Unknown activation refusal reason/);
  });
});

/** Capture whatever `throwWorkflowCatalogOperationFault` throws, without a trailing statement TS would flag as unreachable (the function's return type is `never`). */
function captureThrown(error: unknown): unknown {
  try {
    throwWorkflowCatalogOperationFault(error);
  } catch (thrown) {
    return thrown;
  }
}

describe('throwWorkflowCatalogOperationFault', () => {
  it('maps WorkflowRevisionNotInstalledError to NotFound', () => {
    const fault = captureThrown(new WorkflowRevisionNotInstalledError('checkout', 'r1'));

    expect(isOperationFault(fault)).toBe(true);
    if (isOperationFault(fault)) {
      expect(fault.code).toBe('NotFound');
    }
  });

  it('maps WorkflowNotRegisteredError to InvalidParams', () => {
    const fault = captureThrown(new WorkflowNotRegisteredError('checkout'));

    expect(isOperationFault(fault)).toBe(true);
    if (isOperationFault(fault)) {
      expect(fault.code).toBe('InvalidParams');
    }
  });

  it('maps WorkflowCatalogConflictError to Conflict', () => {
    const fault = captureThrown(new WorkflowCatalogConflictError('checkout', 'r1'));

    expect(isOperationFault(fault)).toBe(true);
    if (isOperationFault(fault)) {
      expect(fault.code).toBe('Conflict');
    }
  });

  it('rethrows an unrecognized error unchanged', () => {
    const original = new Error('something else entirely');

    expect(() => throwWorkflowCatalogOperationFault(original)).toThrow(original);
  });
});

describe('readWorkflowCatalogRestBody', () => {
  it('returns the parsed object for a well-formed JSON body', async () => {
    const request = new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ manifest: { ok: true } }),
    });

    const body = await readWorkflowCatalogRestBody(request, {});

    expect(body['manifest']).toEqual({ ok: true });
  });

  it('faults with InvalidParams for malformed JSON', async () => {
    const request = new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json {',
    });

    await expect(readWorkflowCatalogRestBody(request, {})).rejects.toMatchObject({
      code: 'InvalidParams',
    });
  });

  it('faults with InvalidParams for a non-object JSON body (array)', async () => {
    const request = new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([1, 2, 3]),
    });

    await expect(readWorkflowCatalogRestBody(request, {})).rejects.toMatchObject({
      code: 'InvalidParams',
    });
  });
});

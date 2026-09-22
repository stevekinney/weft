/**
 * Direct unit tests for `operation-helpers.ts`'s boundary-validation guards.
 * `operation-engine-capabilities.test.ts` already exercises these functions
 * against a valid-but-incomplete engine/storage object (the "structural
 * capability is missing" branches); these tests cover the residual
 * "the boundary value itself isn't an object at all" branches those cases
 * never reach, plus `assertOperationStorageMethod`/
 * `requireOperationStorageMethod`, which no existing test called directly.
 */
import { describe, expect, it } from 'bun:test';

import {
  assertOperationEngineMethods,
  assertOperationEngineObject,
  assertOperationStorageMethod,
  assertOperationWorkflowMethods,
  requireOperationStorage,
  requireOperationStorageMethod,
} from './operation-helpers.ts';

const NON_OBJECT_ENGINE_BOUNDARIES: ReadonlyArray<[label: string, value: unknown]> = [
  ['null', null],
  ['undefined', undefined],
  ['a string', 'engine'],
  ['a number', 42],
  ['an array', []],
];

describe('assertOperationEngineObject', () => {
  it('accepts any non-null, non-array object', () => {
    expect(() => assertOperationEngineObject({})).not.toThrow();
  });

  for (const [label, value] of NON_OBJECT_ENGINE_BOUNDARIES) {
    it(`rejects ${label} as not an engine object`, () => {
      expect(() => assertOperationEngineObject(value)).toThrow(
        'Operation requires an engine object.',
      );
    });
  }
});

describe('assertOperationEngineMethods — boundary is not an object', () => {
  for (const [label, value] of NON_OBJECT_ENGINE_BOUNDARIES) {
    it(`rejects ${label} before checking methods`, () => {
      expect(() => assertOperationEngineMethods(value, ['cancelAll'])).toThrow(
        'Operation requires an engine with the requested capabilities.',
      );
    });
  }
});

describe('assertOperationWorkflowMethods — boundary is not an object', () => {
  for (const [label, value] of NON_OBJECT_ENGINE_BOUNDARIES) {
    it(`rejects ${label} before checking workflows`, () => {
      expect(() => assertOperationWorkflowMethods(value, ['getActive'])).toThrow(
        'Operation requires an engine with the requested capabilities.',
      );
    });
  }
});

describe('requireOperationStorage — boundary is not an object', () => {
  for (const [label, value] of NON_OBJECT_ENGINE_BOUNDARIES) {
    it(`rejects ${label} before checking storage`, () => {
      expect(() => requireOperationStorage(value, ['get'])).toThrow(
        'Raw storage operations require an engine with storage capabilities.',
      );
    });
  }
});

describe('assertOperationStorageMethod', () => {
  it('accepts a storage object exposing the requested method', () => {
    const storage = { get: async () => null };
    expect(() => assertOperationStorageMethod(storage, 'get')).not.toThrow();
  });

  it('rejects a storage boundary that is not an object', () => {
    expect(() => assertOperationStorageMethod(null, 'get')).toThrow(
      'Operation storage is missing required method "get".',
    );
  });

  it('rejects a storage object missing the requested method', () => {
    expect(() => assertOperationStorageMethod({}, 'put')).toThrow(
      'Operation storage is missing required method "put".',
    );
  });

  it('uses the supplied message when the method is missing', () => {
    expect(() => assertOperationStorageMethod({}, 'delete', 'custom message')).toThrow(
      'custom message',
    );
  });
});

describe('requireOperationStorageMethod', () => {
  it('returns the storage object when it exposes the requested method', () => {
    const storage = {
      scan: async function* (): AsyncIterable<[string, Uint8Array]> {},
    };
    expect(requireOperationStorageMethod(storage, 'scan')).toBe(storage);
  });

  it('throws with the default message when the method is missing', () => {
    expect(() => requireOperationStorageMethod({}, 'batch')).toThrow(
      'Operation storage is missing required method "batch".',
    );
  });

  it('throws with a supplied message when the method is missing', () => {
    expect(() =>
      requireOperationStorageMethod({}, 'conditionalBatch', 'need conditionalBatch'),
    ).toThrow('need conditionalBatch');
  });
});

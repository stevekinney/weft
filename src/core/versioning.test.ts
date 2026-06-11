import { describe, expect, it } from 'bun:test';

import {
  DEFAULT_WORKFLOW_VERSION,
  VersionMismatchError,
  checkVersionCompatibility,
  diffCheckpointShapes,
  inferShape,
} from './versioning.ts';

describe('checkVersionCompatibility', () => {
  it('returns "compatible" when versions are the same', () => {
    expect(checkVersionCompatibility('1.0.0', '1.0.0')).toBe('compatible');
    expect(checkVersionCompatibility('2.3.1', '2.3.1')).toBe('compatible');
  });

  it('returns "incompatible" when versions differ', () => {
    expect(checkVersionCompatibility('1.0.0', '2.0.0')).toBe('incompatible');
  });
});

describe('VersionMismatchError', () => {
  it('includes all version info as properties', () => {
    const error = new VersionMismatchError('wf-123', 'payment-workflow', '1.0.0', '2.0.0');

    expect(error.workflowId).toBe('wf-123');
    expect(error.workflowType).toBe('payment-workflow');
    expect(error.storedVersion).toBe('1.0.0');
    expect(error.registeredVersion).toBe('2.0.0');
  });

  it('has a descriptive error message', () => {
    const error = new VersionMismatchError('wf-456', 'order-workflow', '1.0.0', '3.0.0');

    expect(error.message).toContain('wf-456');
    expect(error.message).toContain('order-workflow');
    expect(error.message).toContain('1.0.0');
    expect(error.message).toContain('3.0.0');
  });

  it('describes persisted-state drift when workflow versions match', () => {
    const error = new VersionMismatchError(
      'wf-version-tuple',
      'versioned-workflow',
      '1.0.0',
      '1.0.0',
      undefined,
      {
        toolVersions: [{ tool: 'search', change: 'changed', from: '1.0.0', to: '2.0.0' }],
      },
    );

    expect(error.message).toContain('persisted state is incompatible');
    expect(error.message).toContain('search');
  });

  it('is an instance of Error', () => {
    const error = new VersionMismatchError('wf-789', 'test-workflow', '1.0.0', '2.0.0');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('VersionMismatchError');
  });
});

describe('DEFAULT_WORKFLOW_VERSION', () => {
  it('is "0.0.0"', () => {
    expect(DEFAULT_WORKFLOW_VERSION).toBe('0.0.0');
  });
});

describe('VersionMismatchError schema diff', () => {
  it('includes field diffs when oldShape and newShape are provided', () => {
    const oldShape = { name: 'string', address: 'string', age: 'number' };
    const newShape = { name: 'string', address: 'object', email: 'string' };

    const error = new VersionMismatchError('wf-schema-1', 'user-workflow', '1.0.0', '2.0.0', {
      oldShape,
      newShape,
    });

    expect(error.message).toContain('address');
    expect(error.message).toContain('string');
    expect(error.message).toContain('object');
    expect(error.fieldDiffs).toBeDefined();
    expect(error.fieldDiffs!.length).toBeGreaterThan(0);
  });

  it('reports added fields', () => {
    const oldShape = { name: 'string' };
    const newShape = { name: 'string', email: 'string' };

    const error = new VersionMismatchError('wf-schema-2', 'user-workflow', '1.0.0', '2.0.0', {
      oldShape,
      newShape,
    });

    const addedDiff = error.fieldDiffs!.find((d) => d.field === 'email');
    expect(addedDiff).toBeDefined();
    expect(addedDiff!.change).toBe('added');
  });

  it('reports removed fields', () => {
    const oldShape = { name: 'string', legacy: 'boolean' };
    const newShape = { name: 'string' };

    const error = new VersionMismatchError('wf-schema-3', 'user-workflow', '1.0.0', '2.0.0', {
      oldShape,
      newShape,
    });

    const removedDiff = error.fieldDiffs!.find((d) => d.field === 'legacy');
    expect(removedDiff).toBeDefined();
    expect(removedDiff!.change).toBe('removed');
  });

  it('reports type-changed fields', () => {
    const oldShape = { address: 'string' };
    const newShape = { address: 'object' };

    const error = new VersionMismatchError('wf-schema-4', 'user-workflow', '1.0.0', '2.0.0', {
      oldShape,
      newShape,
    });

    const changedDiff = error.fieldDiffs!.find((d) => d.field === 'address');
    expect(changedDiff).toBeDefined();
    expect(changedDiff!.change).toBe('type-changed');
    // Narrow the union to access type-changed-specific properties
    if (changedDiff!.change === 'type-changed') {
      expect(changedDiff!.oldType).toBe('string');
      expect(changedDiff!.newType).toBe('object');
    }
  });

  it('has no fieldDiffs when shapes are not provided', () => {
    const error = new VersionMismatchError('wf-schema-5', 'user-workflow', '1.0.0', '2.0.0');

    expect(error.fieldDiffs).toBeUndefined();
  });
});

describe('diffCheckpointShapes', () => {
  it('returns empty array when shapes are identical', () => {
    const diffs = diffCheckpointShapes(
      { name: 'string', age: 'number' },
      { name: 'string', age: 'number' },
    );
    expect(diffs).toEqual([]);
  });

  it('detects all change types in a single comparison', () => {
    const diffs = diffCheckpointShapes(
      { kept: 'string', removed: 'boolean', changed: 'string' },
      { kept: 'string', added: 'number', changed: 'object' },
    );

    expect(diffs).toHaveLength(3);

    const removed = diffs.find((d) => d.field === 'removed');
    expect(removed).toEqual({ field: 'removed', change: 'removed', oldType: 'boolean' });

    const added = diffs.find((d) => d.field === 'added');
    expect(added).toEqual({ field: 'added', change: 'added', newType: 'number' });

    const changed = diffs.find((d) => d.field === 'changed');
    expect(changed).toEqual({
      field: 'changed',
      change: 'type-changed',
      oldType: 'string',
      newType: 'object',
    });
  });
});

describe('inferShape', () => {
  it('infers types from a plain object', () => {
    const shape = inferShape({ name: 'Alice', age: 30, active: true });
    expect(shape).toEqual({ name: 'string', age: 'number', active: 'boolean' });
  });

  it('handles null values', () => {
    const shape = inferShape({ value: null });
    expect(shape).toEqual({ value: 'null' });
  });

  it('detects arrays as "array" not "object"', () => {
    const shape = inferShape({ items: [1, 2, 3] });
    expect(shape).toEqual({ items: 'array' });
  });

  it('detects nested objects as "object"', () => {
    const shape = inferShape({ address: { street: '123 Main' } });
    expect(shape).toEqual({ address: 'object' });
  });

  it('returns empty shape for null input', () => {
    expect(inferShape(null)).toEqual({});
  });

  it('returns empty shape for array input', () => {
    expect(inferShape([1, 2])).toEqual({});
  });

  it('returns empty shape for primitive input', () => {
    expect(inferShape('hello')).toEqual({});
    expect(inferShape(42)).toEqual({});
  });
});

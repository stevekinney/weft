import { ExtData, encode as msgpackEncode } from '@msgpack/msgpack';
import { describe, expect, it } from 'bun:test';

import {
  advanceCheckpoint,
  checkpointSizeBytes,
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
  validateCheckpointRoundTrip,
} from './checkpoint.ts';
import { RegExpExtensionDecodeError } from './codec/extension-codec.ts';
import {
  CURRENT_CHECKPOINT_SCHEMA_VERSION,
  WORKER_REPLAY_SIGNATURE_FORMAT,
  type Checkpoint,
  type Serializer,
} from './types.ts';

const REGEXP_EXTENSION_TYPE = 2;

function encodeCheckpointWithRegExpExtension(
  source: string,
  flags: string,
  workflowId = 'wf-regexp-decode',
): Uint8Array {
  return msgpackEncode({
    workflowId,
    step: 1,
    locals: {
      pattern: new ExtData(REGEXP_EXTENSION_TYPE, msgpackEncode({ source, flags })),
    },
    accumulatedResults: [],
    searchAttributes: {},
    version: '1.0.0',
    schemaVersion: CURRENT_CHECKPOINT_SCHEMA_VERSION,
    createdAt: 1_778_716_800_000,
  });
}

describe('createCheckpoint', () => {
  it('produces step 0, empty locals, empty accumulated results, empty searchAttributes', () => {
    const checkpoint = createCheckpoint('wf-1', '1.0.0');

    expect(checkpoint.step).toBe(0);
    expect(checkpoint.locals).toEqual({});
    expect(checkpoint.accumulatedResults).toEqual([]);
    expect(checkpoint.searchAttributes).toEqual({});
  });

  it('produces a valid Checkpoint shape', () => {
    const checkpoint = createCheckpoint('wf-1', '1.0.0');

    expect(checkpoint.workflowId).toBe('wf-1');
    expect(checkpoint.version).toBe('1.0.0');
    expect(typeof checkpoint.step).toBe('number');
    expect(typeof checkpoint.createdAt).toBe('number');
    expect(checkpoint.createdAt).toBeGreaterThan(0);
    expect(typeof checkpoint.locals).toBe('object');
    expect(checkpoint).not.toHaveProperty('pendingSignals');
    expect(typeof checkpoint.searchAttributes).toBe('object');
  });
});

describe('advanceCheckpoint', () => {
  it('increments step by 1', () => {
    const checkpoint = createCheckpoint('wf-1', '1.0.0');
    const advanced = advanceCheckpoint(checkpoint, { count: 42 });

    expect(advanced.step).toBe(1);
  });

  it('replaces locals with new values', () => {
    const checkpoint = createCheckpoint('wf-1', '1.0.0');
    const first = advanceCheckpoint(checkpoint, { a: 1 });
    const second = advanceCheckpoint(first, { b: 2 });

    expect(second.locals).toEqual({ b: 2 });
    expect(second.locals).not.toHaveProperty('a');
  });

  it('merges search attributes (existing preserved, new added)', () => {
    const checkpoint = createCheckpoint('wf-1', '1.0.0');
    const first = advanceCheckpoint(
      checkpoint,
      {},
      {
        searchAttributes: { region: 'us-east' },
      },
    );
    const second = advanceCheckpoint(
      first,
      {},
      {
        searchAttributes: { priority: 'high' },
      },
    );

    expect(second.searchAttributes).toEqual({
      region: 'us-east',
      priority: 'high',
    });
  });

  it('updates createdAt', () => {
    const checkpoint = createCheckpoint('wf-1', '1.0.0');
    const before = checkpoint.createdAt;
    const advanced = advanceCheckpoint(checkpoint, {});

    expect(advanced.createdAt).toBeGreaterThanOrEqual(before);
  });

  it('preserves workflowId and version', () => {
    const checkpoint = createCheckpoint('wf-42', '2.5.0');
    const advanced = advanceCheckpoint(checkpoint, { x: 'hello' });

    expect(advanced.workflowId).toBe('wf-42');
    expect(advanced.version).toBe('2.5.0');
  });

  it('increments step through multiple advances: 0 -> 1 -> 2 -> 3', () => {
    let checkpoint = createCheckpoint('wf-1', '1.0.0');

    expect(checkpoint.step).toBe(0);

    checkpoint = advanceCheckpoint(checkpoint, { a: 1 });
    expect(checkpoint.step).toBe(1);

    checkpoint = advanceCheckpoint(checkpoint, { b: 2 });
    expect(checkpoint.step).toBe(2);

    checkpoint = advanceCheckpoint(checkpoint, { c: 3 });
    expect(checkpoint.step).toBe(3);
  });

  it('preserves Worker replay signatures while advancing', () => {
    const checkpoint: Checkpoint = {
      ...createCheckpoint('wf-1', '1.0.0'),
      workerReplaySignatures: [
        [
          0,
          {
            format: WORKER_REPLAY_SIGNATURE_FORMAT,
            operationType: 'activity',
            stableFieldsDigest: 'abc123',
            stableFieldsByteLength: 42,
          },
        ],
      ],
    };

    const advanced = advanceCheckpoint(checkpoint, { done: true });

    expect(advanced.workerReplaySignatures).toEqual(checkpoint.workerReplaySignatures);
  });

  it('preserves Worker replay failures while advancing', () => {
    const checkpoint: Checkpoint = {
      ...createCheckpoint('wf-1', '1.0.0'),
      workerReplayFailures: [
        [
          0,
          {
            status: 'failed',
            error: 'activity failed',
            failureCategory: 'timeout',
          },
        ],
      ],
    };

    const advanced = advanceCheckpoint(checkpoint, { done: true });

    expect(advanced.workerReplayFailures).toEqual(checkpoint.workerReplayFailures);
  });
});

describe('serializeCheckpoint / deserializeCheckpoint', () => {
  it('round-trips cleanly for a simple checkpoint', () => {
    const original = createCheckpoint('wf-1', '1.0.0');
    const bytes = serializeCheckpoint(original);
    const restored = deserializeCheckpoint(bytes);

    expect(restored).toEqual(original);
  });

  it('omits pendingSignals from fresh serialized checkpoints', () => {
    const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint('wf-1', '1.0.0')));

    expect(restored).not.toHaveProperty('pendingSignals');
  });

  it('normalizes checkpoints that still contain the retired pendingSignals field', () => {
    const { encode } = require('./codec.ts');
    const bytes = encode({
      workflowId: 'wf-old-signals',
      step: 2,
      locals: { waiting: true },
      accumulatedResults: [[1, 'done']],
      pendingSignals: ['old-checkpoint-signal'],
      searchAttributes: {},
      version: '1.0.0',
      schemaVersion: CURRENT_CHECKPOINT_SCHEMA_VERSION,
      createdAt: 1_778_716_800_000,
    });

    const restored = deserializeCheckpoint(bytes);

    expect(restored.workflowId).toBe('wf-old-signals');
    expect(restored.step).toBe(2);
    expect(restored.accumulatedResults).toEqual([[1, 'done']]);
    expect(restored).not.toHaveProperty('pendingSignals');
  });

  it('round-trips with Date in locals', () => {
    const now = new Date();
    let checkpoint = createCheckpoint('wf-1', '1.0.0');
    checkpoint = advanceCheckpoint(checkpoint, { startedAt: now });

    const bytes = serializeCheckpoint(checkpoint);
    const restored = deserializeCheckpoint(bytes);

    expect(restored.locals['startedAt']).toBeInstanceOf(Date);
    expect((restored.locals['startedAt'] as Date).getTime()).toBe(now.getTime());
  });

  it('round-trips with Map and Set in locals', () => {
    const map = new Map([
      ['key1', 'value1'],
      ['key2', 'value2'],
    ]);
    const set = new Set([1, 2, 3]);
    let checkpoint = createCheckpoint('wf-1', '1.0.0');
    checkpoint = advanceCheckpoint(checkpoint, { myMap: map, mySet: set });

    const bytes = serializeCheckpoint(checkpoint);
    const restored = deserializeCheckpoint(bytes);

    expect(restored.locals['myMap']).toBeInstanceOf(Map);
    expect(restored.locals['mySet']).toBeInstanceOf(Set);
    expect([...(restored.locals['myMap'] as Map<string, string>).entries()]).toEqual([
      ['key1', 'value1'],
      ['key2', 'value2'],
    ]);
    expect([...(restored.locals['mySet'] as Set<number>).values()]).toEqual([1, 2, 3]);
  });

  it('round-trips with nested objects and arrays', () => {
    let checkpoint = createCheckpoint('wf-1', '1.0.0');
    checkpoint = advanceCheckpoint(checkpoint, {
      nested: { deep: { value: 42 } },
      list: [1, 'two', { three: 3 }],
    });

    const bytes = serializeCheckpoint(checkpoint);
    const restored = deserializeCheckpoint(bytes);

    expect(restored.locals).toEqual(checkpoint.locals);
  });

  it('throws a typed RegExp extension decode error for invalid persisted flags', () => {
    const bytes = encodeCheckpointWithRegExpExtension('hello', 'z');

    expect(() => deserializeCheckpoint(bytes)).toThrow(RegExpExtensionDecodeError);

    try {
      deserializeCheckpoint(bytes);
    } catch (error) {
      expect(error).toBeInstanceOf(RegExpExtensionDecodeError);
      const decodeError = error as RegExpExtensionDecodeError;
      expect(decodeError.extensionType).toBe(REGEXP_EXTENSION_TYPE);
      expect(decodeError.source).toBe('hello');
      expect(decodeError.flags).toBe('z');
      expect(decodeError.message).toContain('RegExp extension type 2');
      expect(decodeError.message).toContain('source="hello"');
      expect(decodeError.message).toContain('flags="z"');
      return;
    }

    throw new Error('Expected deserializeCheckpoint to throw');
  });

  it('rejects RegExp checkpoint sources above the persisted source byte limit', () => {
    const oversizedSource = 'a'.repeat(65_536);
    const bytes = encodeCheckpointWithRegExpExtension(oversizedSource, '');

    expect(() => deserializeCheckpoint(bytes)).toThrow(RegExpExtensionDecodeError);

    try {
      deserializeCheckpoint(bytes);
    } catch (error) {
      expect(error).toBeInstanceOf(RegExpExtensionDecodeError);
      const decodeError = error as RegExpExtensionDecodeError;
      expect(decodeError.extensionType).toBe(REGEXP_EXTENSION_TYPE);
      expect(decodeError.source).toBe(oversizedSource);
      expect(decodeError.flags).toBe('');
      expect(decodeError.sourceByteLength).toBe(65_536);
      expect(decodeError.message).toContain('exceeds the 65535-byte limit');
      return;
    }

    throw new Error('Expected deserializeCheckpoint to throw');
  });

  it('round-trips Worker replay signatures without changing the schema version', () => {
    const checkpoint: Checkpoint = {
      ...createCheckpoint('wf-worker-replay', '1.0.0'),
      accumulatedResults: [[0, 'cached-result']],
      workerReplaySignatures: [
        [
          0,
          {
            format: WORKER_REPLAY_SIGNATURE_FORMAT,
            operationType: 'activity',
            stableFieldsDigest: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            stableFieldsByteLength: 128,
          },
        ],
      ],
    };

    const restored = deserializeCheckpoint(serializeCheckpoint(checkpoint));

    expect(restored.schemaVersion).toBe(CURRENT_CHECKPOINT_SCHEMA_VERSION);
    expect(restored.workerReplaySignatures).toEqual(checkpoint.workerReplaySignatures);
  });

  it('preserves the representative checkpoint byte encoding', () => {
    const baseCheckpoint = createCheckpoint('wf-byte-fixture', '1.2.3');
    const checkpoint: Checkpoint = {
      ...advanceCheckpoint(baseCheckpoint, {
        count: 42,
        createdAt: new Date('2026-05-14T00:00:00.000Z'),
        tags: new Set(['core', 'codec']),
        lookup: new Map<string, unknown>([
          ['alpha', { ok: true }],
          ['beta', undefined],
        ]),
        bytes: new Uint8Array([1, 2, 3, 255]),
      }),
      createdAt: 1_778_716_800_000,
    };

    expect(Array.from(serializeCheckpoint(checkpoint))).toEqual([
      136, 170, 119, 111, 114, 107, 102, 108, 111, 119, 73, 100, 175, 119, 102, 45, 98, 121, 116,
      101, 45, 102, 105, 120, 116, 117, 114, 101, 164, 115, 116, 101, 112, 1, 166, 108, 111, 99, 97,
      108, 115, 133, 165, 99, 111, 117, 110, 116, 42, 169, 99, 114, 101, 97, 116, 101, 100, 65, 116,
      214, 255, 106, 5, 16, 128, 164, 116, 97, 103, 115, 199, 12, 4, 146, 164, 99, 111, 114, 101,
      165, 99, 111, 100, 101, 99, 166, 108, 111, 111, 107, 117, 112, 199, 22, 3, 146, 146, 165, 97,
      108, 112, 104, 97, 129, 162, 111, 107, 195, 146, 164, 98, 101, 116, 97, 199, 0, 5, 165, 98,
      121, 116, 101, 115, 196, 4, 1, 2, 3, 255, 178, 97, 99, 99, 117, 109, 117, 108, 97, 116, 101,
      100, 82, 101, 115, 117, 108, 116, 115, 144, 176, 115, 101, 97, 114, 99, 104, 65, 116, 116,
      114, 105, 98, 117, 116, 101, 115, 128, 167, 118, 101, 114, 115, 105, 111, 110, 165, 49, 46,
      50, 46, 51, 173, 115, 99, 104, 101, 109, 97, 86, 101, 114, 115, 105, 111, 110, 2, 169, 99,
      114, 101, 97, 116, 101, 100, 65, 116, 207, 0, 0, 1, 158, 35, 200, 116, 0,
    ]);
  });

  it('throws on corrupted bytes', () => {
    const corrupted = new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0x99]);

    expect(() => deserializeCheckpoint(corrupted)).toThrow();
  });

  it('throws on valid bytes but wrong shape (missing step field)', () => {
    const { encode } = require('./codec.ts');
    const invalid = encode({ workflowId: 'wf-1', locals: {} });

    expect(() => deserializeCheckpoint(invalid)).toThrow();
  });
});

describe('validateCheckpointRoundTrip', () => {
  it('returns valid: true for a clean checkpoint', () => {
    const checkpoint = createCheckpoint('wf-1', '1.0.0');
    const result = validateCheckpointRoundTrip(checkpoint);

    expect(result.valid).toBe(true);
    expect(result.divergences).toEqual([]);
    expect(result.sizeBytes).toBeGreaterThan(0);
  });

  it('detects non-cloneable values (function in locals)', () => {
    const checkpoint: Checkpoint = {
      workflowId: 'wf-1',
      step: 1,
      locals: { handler: () => 'not serializable' },
      accumulatedResults: [],
      searchAttributes: {},
      version: '1.0.0',
      schemaVersion: CURRENT_CHECKPOINT_SCHEMA_VERSION,
      createdAt: Date.now(),
    };

    const result = validateCheckpointRoundTrip(checkpoint);

    expect(result.valid).toBe(false);
    expect(result.divergences.length).toBeGreaterThan(0);
  });

  it('reports path of divergent field', () => {
    const checkpoint: Checkpoint = {
      workflowId: 'wf-1',
      step: 1,
      locals: { nested: { callback: () => {} } },
      accumulatedResults: [],
      searchAttributes: {},
      version: '1.0.0',
      schemaVersion: CURRENT_CHECKPOINT_SCHEMA_VERSION,
      createdAt: Date.now(),
    };

    const result = validateCheckpointRoundTrip(checkpoint);

    expect(result.valid).toBe(false);
    const paths = result.divergences.map((d) => d.path);
    expect(paths.some((p) => p.includes('nested') && p.includes('callback'))).toBe(true);
  });
});

describe('checkpointSizeBytes', () => {
  it('returns a positive number', () => {
    const checkpoint = createCheckpoint('wf-1', '1.0.0');
    const size = checkpointSizeBytes(checkpoint);

    expect(size).toBeGreaterThan(0);
  });

  it('increases with larger locals', () => {
    const small = createCheckpoint('wf-1', '1.0.0');
    const large = advanceCheckpoint(small, {
      data: 'x'.repeat(10_000),
      moreData: Array.from({ length: 100 }, (_, i) => i),
    });

    expect(checkpointSizeBytes(large)).toBeGreaterThan(checkpointSizeBytes(small));
  });
});

describe('custom serializer', () => {
  it('JSON-based serializer works with serialize/deserialize', () => {
    const jsonSerializer: Serializer = {
      serialize(value: unknown): Uint8Array {
        return new TextEncoder().encode(JSON.stringify(value));
      },
      deserialize(bytes: Uint8Array): unknown {
        return JSON.parse(new TextDecoder().decode(bytes));
      },
    };

    const checkpoint = createCheckpoint('wf-1', '1.0.0');
    const bytes = serializeCheckpoint(checkpoint, jsonSerializer);
    const restored = deserializeCheckpoint(bytes, jsonSerializer);

    expect(restored.workflowId).toBe('wf-1');
    expect(restored.step).toBe(0);
    expect(restored.version).toBe('1.0.0');
  });
});

describe('validateCheckpointShape (via deserializeCheckpoint)', () => {
  it('throws when decoded value is not an object', () => {
    const { encode } = require('./codec.ts');
    const bytes = encode('not-an-object');
    expect(() => deserializeCheckpoint(bytes)).toThrow('expected an object');
  });

  it('throws when decoded value is null', () => {
    const { encode } = require('./codec.ts');
    const bytes = encode(null);
    expect(() => deserializeCheckpoint(bytes)).toThrow('expected an object');
  });

  it('throws when workflowId is missing', () => {
    const { encode } = require('./codec.ts');
    const bytes = encode({
      step: 0,
      locals: {},
      accumulatedResults: [],
      searchAttributes: {},
      version: '1.0.0',
      schemaVersion: CURRENT_CHECKPOINT_SCHEMA_VERSION,
      createdAt: Date.now(),
    });
    expect(() => deserializeCheckpoint(bytes)).toThrow('workflowId');
  });

  it('throws when step is missing', () => {
    const { encode } = require('./codec.ts');
    const bytes = encode({
      workflowId: 'wf-1',
      locals: {},
      accumulatedResults: [],
      searchAttributes: {},
      version: '1.0.0',
      schemaVersion: CURRENT_CHECKPOINT_SCHEMA_VERSION,
      createdAt: Date.now(),
    });
    expect(() => deserializeCheckpoint(bytes)).toThrow('step');
  });

  it('throws when locals is missing or null', () => {
    const { encode } = require('./codec.ts');
    const bytes = encode({
      workflowId: 'wf-1',
      step: 0,
      locals: null,
      accumulatedResults: [],
      searchAttributes: {},
      version: '1.0.0',
      schemaVersion: CURRENT_CHECKPOINT_SCHEMA_VERSION,
      createdAt: Date.now(),
    });
    expect(() => deserializeCheckpoint(bytes)).toThrow('locals');
  });

  it('drops retired pendingSignals from checkpoint bytes', () => {
    const { encode } = require('./codec.ts');
    const bytes = encode({
      workflowId: 'wf-1',
      step: 0,
      locals: {},
      pendingSignals: 'not-an-array',
      searchAttributes: {},
      version: '1.0.0',
      schemaVersion: CURRENT_CHECKPOINT_SCHEMA_VERSION,
      createdAt: Date.now(),
    });

    const restored = deserializeCheckpoint(bytes);

    expect(restored).not.toHaveProperty('pendingSignals');
  });

  it('throws when accumulatedResults is not an array', () => {
    const { encode } = require('./codec.ts');
    const bytes = encode({
      workflowId: 'wf-1',
      step: 0,
      locals: {},
      accumulatedResults: 'not-an-array',
      searchAttributes: {},
      version: '1.0.0',
      schemaVersion: CURRENT_CHECKPOINT_SCHEMA_VERSION,
      createdAt: Date.now(),
    });
    expect(() => deserializeCheckpoint(bytes)).toThrow('accumulatedResults');
  });

  it('throws when searchAttributes is missing or null', () => {
    const { encode } = require('./codec.ts');
    const bytes = encode({
      workflowId: 'wf-1',
      step: 0,
      locals: {},
      accumulatedResults: [],
      searchAttributes: null,
      version: '1.0.0',
      schemaVersion: CURRENT_CHECKPOINT_SCHEMA_VERSION,
      createdAt: Date.now(),
    });
    expect(() => deserializeCheckpoint(bytes)).toThrow('searchAttributes');
  });

  it('throws when version is missing', () => {
    const { encode } = require('./codec.ts');
    const bytes = encode({
      workflowId: 'wf-1',
      step: 0,
      locals: {},
      accumulatedResults: [],
      searchAttributes: {},
      createdAt: Date.now(),
    });
    expect(() => deserializeCheckpoint(bytes)).toThrow('version');
  });

  it('throws when createdAt is missing', () => {
    const { encode } = require('./codec.ts');
    const bytes = encode({
      workflowId: 'wf-1',
      step: 0,
      locals: {},
      accumulatedResults: [],
      searchAttributes: {},
      version: '1.0.0',
    });
    expect(() => deserializeCheckpoint(bytes)).toThrow('createdAt');
  });

  it('throws when Worker replay signatures have invalid entries', () => {
    const { encode } = require('./codec.ts');
    const bytes = encode({
      workflowId: 'wf-invalid-worker-replay',
      step: 0,
      locals: {},
      accumulatedResults: [],
      workerReplaySignatures: [
        [
          'not-a-step',
          {
            format: WORKER_REPLAY_SIGNATURE_FORMAT,
            operationType: 'activity',
            stableFieldsDigest: 'abc123',
            stableFieldsByteLength: 42,
          },
        ],
      ],
      searchAttributes: {},
      version: '1.0.0',
      schemaVersion: CURRENT_CHECKPOINT_SCHEMA_VERSION,
      createdAt: Date.now(),
    });

    expect(() => deserializeCheckpoint(bytes)).toThrow('workerReplaySignatures');
  });

  it('validates every Worker replay signature field individually', () => {
    const { encode } = require('./codec.ts');
    const cases = [
      {
        workerReplaySignatures: 'not-an-array',
      },
      {
        workerReplaySignatures: [[0, null]],
      },
      {
        workerReplaySignatures: [['step-only']],
      },
      {
        workerReplaySignatures: [
          [
            0,
            {
              format: 'wrong-format',
              operationType: 'activity',
              stableFieldsDigest: 'abc123',
              stableFieldsByteLength: 42,
            },
          ],
        ],
      },
      {
        workerReplaySignatures: [
          [
            0,
            {
              format: WORKER_REPLAY_SIGNATURE_FORMAT,
              operationType: 42,
              stableFieldsDigest: 'abc123',
              stableFieldsByteLength: 42,
            },
          ],
        ],
      },
      {
        workerReplaySignatures: [
          [
            0,
            {
              format: WORKER_REPLAY_SIGNATURE_FORMAT,
              operationType: 'activity',
              stableFieldsDigest: 42,
              stableFieldsByteLength: 42,
            },
          ],
        ],
      },
      {
        workerReplaySignatures: [
          [
            0,
            {
              format: WORKER_REPLAY_SIGNATURE_FORMAT,
              operationType: 'activity',
              stableFieldsDigest: 'abc123',
              stableFieldsByteLength: -1,
            },
          ],
        ],
      },
    ];

    for (const testCase of cases) {
      const bytes = encode({
        workflowId: 'wf-invalid-worker-replay-fields',
        step: 0,
        locals: {},
        accumulatedResults: [],
        searchAttributes: {},
        version: '1.0.0',
        schemaVersion: CURRENT_CHECKPOINT_SCHEMA_VERSION,
        createdAt: Date.now(),
        ...testCase,
      });

      expect(() => deserializeCheckpoint(bytes)).toThrow('workerReplaySignatures');
    }
  });

  it('throws when Worker replay failures have invalid entries', () => {
    const { encode } = require('./codec.ts');
    const bytes = encode({
      workflowId: 'wf-invalid-worker-replay-failure',
      step: 0,
      locals: {},
      accumulatedResults: [],
      workerReplayFailures: [
        [
          0,
          {
            status: 'failed',
            error: 'activity failed',
            failureCategory: 'not-real',
          },
        ],
      ],
      searchAttributes: {},
      version: '1.0.0',
      schemaVersion: CURRENT_CHECKPOINT_SCHEMA_VERSION,
      createdAt: Date.now(),
    });

    expect(() => deserializeCheckpoint(bytes)).toThrow('workerReplayFailures');
  });

  it('validates every Worker replay failure field individually', () => {
    const { encode } = require('./codec.ts');
    const cases = [
      { workerReplayFailures: 'not-an-array' },
      { workerReplayFailures: [[0, null]] },
      { workerReplayFailures: [['step-only']] },
      { workerReplayFailures: [[0, { status: 'completed', error: 'activity failed' }]] },
      { workerReplayFailures: [[0, { status: 'failed', error: 42 }]] },
      {
        workerReplayFailures: [[0, { status: 'failed', error: 'activity failed', errorName: 42 }]],
      },
      {
        workerReplayFailures: [
          [0, { status: 'failed', error: 'activity failed', failureCategory: 'not-real' }],
        ],
      },
    ];

    for (const testCase of cases) {
      const bytes = encode({
        workflowId: 'wf-invalid-worker-replay-failure-fields',
        step: 0,
        locals: {},
        accumulatedResults: [],
        searchAttributes: {},
        version: '1.0.0',
        schemaVersion: CURRENT_CHECKPOINT_SCHEMA_VERSION,
        createdAt: Date.now(),
        ...testCase,
      });

      expect(() => deserializeCheckpoint(bytes)).toThrow('workerReplayFailures');
    }
  });

  it('accepts every current Worker replay failure category', () => {
    const failureCategories = [
      'application',
      'cancellation',
      'resource',
      'system',
      'timeout',
    ] as const;

    for (const failureCategory of failureCategories) {
      const checkpoint: Checkpoint = {
        ...createCheckpoint(`wf-${failureCategory}`, '1.0.0'),
        workerReplayFailures: [
          [
            0,
            {
              status: 'failed',
              error: 'activity failed',
              failureCategory,
            },
          ],
        ],
      };

      expect(deserializeCheckpoint(serializeCheckpoint(checkpoint))).toMatchObject({
        workerReplayFailures: checkpoint.workerReplayFailures,
      });
    }
  });

  it('rejects malformed accumulated-result replay watermarks', () => {
    for (const accumulatedResultReplayWatermark of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const bytes = serializeCheckpoint({
        ...createCheckpoint('wf-invalid-watermark', '1.0.0'),
        accumulatedResultReplayWatermark,
      });

      expect(() => deserializeCheckpoint(bytes)).toThrow('accumulatedResultReplayWatermark');
    }
  });

  it('throws when schemaVersion is not an integer number', () => {
    const { encode } = require('./codec.ts');
    const bytes = encode({
      workflowId: 'wf-invalid-schema-version',
      step: 0,
      locals: {},
      accumulatedResults: [],
      searchAttributes: {},
      version: '1.0.0',
      schemaVersion: '2',
      createdAt: Date.now(),
    });

    expect(() => deserializeCheckpoint(bytes)).toThrow('schemaVersion');
  });
});

describe('compareValues (via validateCheckpointRoundTrip with custom serializer)', () => {
  // Helper: a serializer that intentionally alters data to trigger divergence paths
  function createAlteringSerializer(alteration: (checkpoint: any) => any): Serializer {
    return {
      serialize(value: unknown): Uint8Array {
        return new TextEncoder().encode(JSON.stringify(value));
      },
      deserialize(bytes: Uint8Array): unknown {
        const parsed = JSON.parse(new TextDecoder().decode(bytes));
        return alteration(parsed);
      },
    };
  }

  it('detects null vs non-null divergence', () => {
    const serializer = createAlteringSerializer((checkpoint: any) => {
      checkpoint.locals.value = null;
      return checkpoint;
    });

    const checkpoint: Checkpoint = {
      workflowId: 'wf-1',
      step: 1,
      locals: { value: 'hello' },
      accumulatedResults: [],
      searchAttributes: {},
      version: '1.0.0',
      schemaVersion: CURRENT_CHECKPOINT_SCHEMA_VERSION,
      createdAt: Date.now(),
    };

    const result = validateCheckpointRoundTrip(checkpoint, serializer);
    expect(result.valid).toBe(false);
    expect(result.divergences.some((d) => d.path.includes('value'))).toBe(true);
  });

  it('detects type mismatch (string vs number)', () => {
    const serializer = createAlteringSerializer((checkpoint: any) => {
      checkpoint.locals.count = 'not-a-number';
      return checkpoint;
    });

    const checkpoint: Checkpoint = {
      workflowId: 'wf-1',
      step: 1,
      locals: { count: 42 },
      accumulatedResults: [],
      searchAttributes: {},
      version: '1.0.0',
      schemaVersion: CURRENT_CHECKPOINT_SCHEMA_VERSION,
      createdAt: Date.now(),
    };

    const result = validateCheckpointRoundTrip(checkpoint, serializer);
    expect(result.valid).toBe(false);
    const divergence = result.divergences.find((d) => d.path.includes('count'));
    expect(divergence).toBeDefined();
    expect(divergence!.suggestion).toContain('Type changed');
  });

  it('detects primitive value change', () => {
    const serializer = createAlteringSerializer((checkpoint: any) => {
      checkpoint.locals.name = 'altered';
      return checkpoint;
    });

    const checkpoint: Checkpoint = {
      workflowId: 'wf-1',
      step: 1,
      locals: { name: 'original' },
      accumulatedResults: [],
      searchAttributes: {},
      version: '1.0.0',
      schemaVersion: CURRENT_CHECKPOINT_SCHEMA_VERSION,
      createdAt: Date.now(),
    };

    const result = validateCheckpointRoundTrip(checkpoint, serializer);
    expect(result.valid).toBe(false);
    expect(result.divergences.some((d) => d.suggestion.includes('Primitive value changed'))).toBe(
      true,
    );
  });

  it('detects missing key in deserialized result', () => {
    const serializer = createAlteringSerializer((checkpoint: any) => {
      delete checkpoint.locals.important;
      return checkpoint;
    });

    const checkpoint: Checkpoint = {
      workflowId: 'wf-1',
      step: 1,
      locals: { important: 'data', other: 'stuff' },
      accumulatedResults: [],
      searchAttributes: {},
      version: '1.0.0',
      schemaVersion: CURRENT_CHECKPOINT_SCHEMA_VERSION,
      createdAt: Date.now(),
    };

    const result = validateCheckpointRoundTrip(checkpoint, serializer);
    expect(result.valid).toBe(false);
    expect(
      result.divergences.some((d) => d.suggestion.includes('Key missing from deserialized')),
    ).toBe(true);
  });

  it('detects extra key in deserialized result', () => {
    const serializer = createAlteringSerializer((checkpoint: any) => {
      checkpoint.locals.extraKey = 'unexpected';
      return checkpoint;
    });

    const checkpoint: Checkpoint = {
      workflowId: 'wf-1',
      step: 1,
      locals: { existing: 'data' },
      accumulatedResults: [],
      searchAttributes: {},
      version: '1.0.0',
      schemaVersion: CURRENT_CHECKPOINT_SCHEMA_VERSION,
      createdAt: Date.now(),
    };

    const result = validateCheckpointRoundTrip(checkpoint, serializer);
    expect(result.valid).toBe(false);
    expect(result.divergences.some((d) => d.suggestion.includes('Extra key appeared'))).toBe(true);
  });

  it('detects array length differences (extra elements after round-trip)', () => {
    const serializer = createAlteringSerializer((checkpoint: any) => {
      checkpoint.locals.items.push('extra');
      return checkpoint;
    });

    const checkpoint: Checkpoint = {
      workflowId: 'wf-1',
      step: 1,
      locals: { items: ['a', 'b'] },
      accumulatedResults: [],
      searchAttributes: {},
      version: '1.0.0',
      schemaVersion: CURRENT_CHECKPOINT_SCHEMA_VERSION,
      createdAt: Date.now(),
    };

    const result = validateCheckpointRoundTrip(checkpoint, serializer);
    expect(result.valid).toBe(false);
    expect(result.divergences.some((d) => d.suggestion.includes('Extra array element'))).toBe(true);
  });

  it('detects array length differences (missing elements after round-trip)', () => {
    const serializer = createAlteringSerializer((checkpoint: any) => {
      checkpoint.locals.items.pop();
      return checkpoint;
    });

    const checkpoint: Checkpoint = {
      workflowId: 'wf-1',
      step: 1,
      locals: { items: ['a', 'b', 'c'] },
      accumulatedResults: [],
      searchAttributes: {},
      version: '1.0.0',
      schemaVersion: CURRENT_CHECKPOINT_SCHEMA_VERSION,
      createdAt: Date.now(),
    };

    const result = validateCheckpointRoundTrip(checkpoint, serializer);
    expect(result.valid).toBe(false);
    expect(result.divergences.some((d) => d.suggestion.includes('Array element missing'))).toBe(
      true,
    );
  });

  it('detects nested object divergence', () => {
    const serializer = createAlteringSerializer((checkpoint: any) => {
      checkpoint.locals.nested.deep.value = 99;
      return checkpoint;
    });

    const checkpoint: Checkpoint = {
      workflowId: 'wf-1',
      step: 1,
      locals: { nested: { deep: { value: 42 } } },
      accumulatedResults: [],
      searchAttributes: {},
      version: '1.0.0',
      schemaVersion: CURRENT_CHECKPOINT_SCHEMA_VERSION,
      createdAt: Date.now(),
    };

    const result = validateCheckpointRoundTrip(checkpoint, serializer);
    expect(result.valid).toBe(false);
    expect(
      result.divergences.some((d) => d.path.includes('nested') && d.path.includes('deep')),
    ).toBe(true);
  });

  it('detects Date divergence in round-trip', () => {
    const checkpoint: Checkpoint = {
      workflowId: 'wf-1',
      step: 1,
      locals: { timestamp: new Date('2025-01-15T10:30:00Z') },
      accumulatedResults: [],
      searchAttributes: {},
      version: '1.0.0',
      schemaVersion: CURRENT_CHECKPOINT_SCHEMA_VERSION,
      createdAt: Date.now(),
    };

    // Default codec preserves Dates, so this should pass cleanly
    const result = validateCheckpointRoundTrip(checkpoint);
    expect(result.valid).toBe(true);
  });

  it('detects Date time change via custom serializer', () => {
    const { encode: codecEncode, decode: codecDecode } = require('./codec.ts');

    const serializer: Serializer = {
      serialize(value: unknown): Uint8Array {
        return codecEncode(value);
      },
      deserialize(bytes: Uint8Array): unknown {
        const decoded = codecDecode(bytes);
        // Shift the Date by 1 second to cause divergence
        if (decoded.locals?.timestamp instanceof Date) {
          decoded.locals.timestamp = new Date(decoded.locals.timestamp.getTime() + 1000);
        }
        return decoded;
      },
    };

    const checkpoint: Checkpoint = {
      workflowId: 'wf-1',
      step: 1,
      locals: { timestamp: new Date('2025-01-15T10:30:00Z') },
      accumulatedResults: [],
      searchAttributes: {},
      version: '1.0.0',
      schemaVersion: CURRENT_CHECKPOINT_SCHEMA_VERSION,
      createdAt: Date.now(),
    };

    const result = validateCheckpointRoundTrip(checkpoint, serializer);
    expect(result.valid).toBe(false);
    expect(result.divergences.some((d) => d.suggestion.includes('Date value changed'))).toBe(true);
  });

  it('detects RegExp divergence via custom serializer', () => {
    const { encode: codecEncode, decode: codecDecode } = require('./codec.ts');

    const serializer: Serializer = {
      serialize(value: unknown): Uint8Array {
        return codecEncode(value);
      },
      deserialize(bytes: Uint8Array): unknown {
        const decoded = codecDecode(bytes);
        // Alter the RegExp flags to cause divergence
        if (decoded.locals?.pattern instanceof RegExp) {
          decoded.locals.pattern = new RegExp(decoded.locals.pattern.source, 'gi');
        }
        return decoded;
      },
    };

    const checkpoint: Checkpoint = {
      workflowId: 'wf-1',
      step: 1,
      locals: { pattern: new RegExp('test', 'g') },
      accumulatedResults: [],
      searchAttributes: {},
      version: '1.0.0',
      schemaVersion: CURRENT_CHECKPOINT_SCHEMA_VERSION,
      createdAt: Date.now(),
    };

    const result = validateCheckpointRoundTrip(checkpoint, serializer);
    expect(result.valid).toBe(false);
    expect(result.divergences.some((d) => d.suggestion.includes('RegExp value changed'))).toBe(
      true,
    );
  });

  it('detects Map key missing after round-trip', () => {
    const { encode: codecEncode, decode: codecDecode } = require('./codec.ts');

    const serializer: Serializer = {
      serialize(value: unknown): Uint8Array {
        return codecEncode(value);
      },
      deserialize(bytes: Uint8Array): unknown {
        const decoded = codecDecode(bytes);
        // Remove a key from the Map
        if (decoded.locals?.myMap instanceof Map) {
          decoded.locals.myMap.delete('alpha');
        }
        return decoded;
      },
    };

    const checkpoint: Checkpoint = {
      workflowId: 'wf-1',
      step: 1,
      locals: {
        myMap: new Map([
          ['alpha', 1],
          ['beta', 2],
        ]),
      },
      accumulatedResults: [],
      searchAttributes: {},
      version: '1.0.0',
      schemaVersion: CURRENT_CHECKPOINT_SCHEMA_VERSION,
      createdAt: Date.now(),
    };

    const result = validateCheckpointRoundTrip(checkpoint, serializer);
    expect(result.valid).toBe(false);
    expect(result.divergences.some((d) => d.suggestion.includes('Map key missing'))).toBe(true);
  });

  it('detects extra Map key after round-trip', () => {
    const { encode: codecEncode, decode: codecDecode } = require('./codec.ts');

    const serializer: Serializer = {
      serialize(value: unknown): Uint8Array {
        return codecEncode(value);
      },
      deserialize(bytes: Uint8Array): unknown {
        const decoded = codecDecode(bytes);
        if (decoded.locals?.myMap instanceof Map) {
          decoded.locals.myMap.set('extra', 999);
        }
        return decoded;
      },
    };

    const checkpoint: Checkpoint = {
      workflowId: 'wf-1',
      step: 1,
      locals: {
        myMap: new Map([['alpha', 1]]),
      },
      accumulatedResults: [],
      searchAttributes: {},
      version: '1.0.0',
      schemaVersion: CURRENT_CHECKPOINT_SCHEMA_VERSION,
      createdAt: Date.now(),
    };

    const result = validateCheckpointRoundTrip(checkpoint, serializer);
    expect(result.valid).toBe(false);
    expect(result.divergences.some((d) => d.suggestion.includes('Extra Map key'))).toBe(true);
  });

  it('detects Set size change after round-trip', () => {
    const { encode: codecEncode, decode: codecDecode } = require('./codec.ts');

    const serializer: Serializer = {
      serialize(value: unknown): Uint8Array {
        return codecEncode(value);
      },
      deserialize(bytes: Uint8Array): unknown {
        const decoded = codecDecode(bytes);
        if (decoded.locals?.mySet instanceof Set) {
          decoded.locals.mySet.add('extra');
        }
        return decoded;
      },
    };

    const checkpoint: Checkpoint = {
      workflowId: 'wf-1',
      step: 1,
      locals: {
        mySet: new Set([1, 2, 3]),
      },
      accumulatedResults: [],
      searchAttributes: {},
      version: '1.0.0',
      schemaVersion: CURRENT_CHECKPOINT_SCHEMA_VERSION,
      createdAt: Date.now(),
    };

    const result = validateCheckpointRoundTrip(checkpoint, serializer);
    expect(result.valid).toBe(false);
    expect(result.divergences.some((d) => d.suggestion.includes('Set size changed'))).toBe(true);
  });

  it('compares Set elements when same size', () => {
    const { encode: codecEncode, decode: codecDecode } = require('./codec.ts');

    const serializer: Serializer = {
      serialize(value: unknown): Uint8Array {
        return codecEncode(value);
      },
      deserialize(bytes: Uint8Array): unknown {
        const decoded = codecDecode(bytes);
        if (decoded.locals?.mySet instanceof Set) {
          // Replace the set with one of the same size but different last element
          decoded.locals.mySet = new Set(['a', 'b', 'altered']);
        }
        return decoded;
      },
    };

    const checkpoint: Checkpoint = {
      workflowId: 'wf-1',
      step: 1,
      locals: {
        mySet: new Set(['a', 'b', 'c']),
      },
      accumulatedResults: [],
      searchAttributes: {},
      version: '1.0.0',
      schemaVersion: CURRENT_CHECKPOINT_SCHEMA_VERSION,
      createdAt: Date.now(),
    };

    const result = validateCheckpointRoundTrip(checkpoint, serializer);
    expect(result.valid).toBe(false);
    expect(result.divergences.some((d) => d.path.includes('Set'))).toBe(true);
  });

  it('compares Map values recursively', () => {
    const { encode: codecEncode, decode: codecDecode } = require('./codec.ts');

    const serializer: Serializer = {
      serialize(value: unknown): Uint8Array {
        return codecEncode(value);
      },
      deserialize(bytes: Uint8Array): unknown {
        const decoded = codecDecode(bytes);
        if (decoded.locals?.myMap instanceof Map) {
          decoded.locals.myMap.set('key1', 'altered');
        }
        return decoded;
      },
    };

    const checkpoint: Checkpoint = {
      workflowId: 'wf-1',
      step: 1,
      locals: {
        myMap: new Map([['key1', 'original']]),
      },
      accumulatedResults: [],
      searchAttributes: {},
      version: '1.0.0',
      schemaVersion: CURRENT_CHECKPOINT_SCHEMA_VERSION,
      createdAt: Date.now(),
    };

    const result = validateCheckpointRoundTrip(checkpoint, serializer);
    expect(result.valid).toBe(false);
    expect(result.divergences.some((d) => d.path.includes('Map(key1)'))).toBe(true);
  });

  it('detects undefined vs non-undefined divergence', () => {
    const serializer = createAlteringSerializer((checkpoint: any) => {
      // Set a field to undefined where it was previously a value
      checkpoint.locals.field = undefined;
      return checkpoint;
    });

    const checkpoint: Checkpoint = {
      workflowId: 'wf-1',
      step: 1,
      locals: { field: 'present' },
      accumulatedResults: [],
      searchAttributes: {},
      version: '1.0.0',
      schemaVersion: CURRENT_CHECKPOINT_SCHEMA_VERSION,
      createdAt: Date.now(),
    };

    const result = validateCheckpointRoundTrip(checkpoint, serializer);
    expect(result.valid).toBe(false);
  });

  it('handles array comparison with recursive elements', () => {
    const serializer = createAlteringSerializer((checkpoint: any) => {
      checkpoint.locals.items[1].nested = 'changed';
      return checkpoint;
    });

    const checkpoint: Checkpoint = {
      workflowId: 'wf-1',
      step: 1,
      locals: {
        items: [{ nested: 'original' }, { nested: 'original' }],
      },
      accumulatedResults: [],
      searchAttributes: {},
      version: '1.0.0',
      schemaVersion: CURRENT_CHECKPOINT_SCHEMA_VERSION,
      createdAt: Date.now(),
    };

    const result = validateCheckpointRoundTrip(checkpoint, serializer);
    expect(result.valid).toBe(false);
  });
});

import { describe, expect, it } from 'bun:test';

import { asciiOfLength, manifestInput, singleWorkflowManifest } from './fixtures.test-support.ts';
import {
  MAX_MANIFEST_ACTIVITY_COUNT,
  MAX_MANIFEST_CAPABILITY_COUNT,
  MAX_MANIFEST_CAPABILITY_DEPTH,
  MAX_MANIFEST_CAPABILITY_STRING_BYTES,
  MAX_MANIFEST_IDENTIFIER_BYTES,
  MAX_MANIFEST_WORKFLOW_COUNT,
  MAX_NORMALIZED_MANIFEST_BYTES,
} from './limits.ts';
import { parseWorkerManifest } from './parse.ts';

function expectRejection(value: unknown): { reason: string; message: string; path?: string } {
  const result = parseWorkerManifest(value);
  if (result.ok) throw new Error('expected the manifest to be rejected');
  return {
    reason: result.reason,
    message: result.message,
    ...(result.path === undefined ? {} : { path: result.path }),
  };
}

function validWorkflow(activities: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workflowVersion: '1.0.0',
    workflowRevision: 'rev-8',
    contractHash: 'sha256:aa',
    activities,
  };
}

describe('parseWorkerManifest — accepted input', () => {
  it('accepts a well-formed manifest and returns it normalized', () => {
    const result = parseWorkerManifest(manifestInput({ capabilities: { z: 1, a: 2 } }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.manifest.capabilities)).toEqual(['a', 'z']);
    expect(result.manifest.deployment.buildId).toBe('b3');
  });

  it('returns the canonical serialization alongside the manifest', () => {
    const result = parseWorkerManifest(manifestInput());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.parse(result.canonicalJson).manifestVersion).toBe(1);
  });

  it('accepts a workflow with activities', () => {
    const result = parseWorkerManifest(singleWorkflowManifest());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.workflows['checkout']?.activities['charge']?.contractHash).toBe(
      'sha256:bb',
    );
  });

  it('accepts an empty runtime version, which browsers and edge runtimes have', () => {
    const result = parseWorkerManifest(
      manifestInput({ runtime: { name: 'browser', version: '' } }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.runtime.version).toBe('');
  });

  it('drops properties the manifest shape does not declare', () => {
    const result = parseWorkerManifest(manifestInput({ smuggled: 'value' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect('smuggled' in result.manifest).toBe(false);
    expect(result.canonicalJson).not.toContain('smuggled');
  });

  it.each(['__proto__', 'constructor', 'toString', 'prototype'])(
    'treats %s as an ordinary workflow name rather than a prototype operation',
    (name) => {
      const result = parseWorkerManifest(
        manifestInput({
          workflows: {
            [name]: {
              workflowVersion: '1.0.0',
              workflowRevision: 'rev-8',
              contractHash: 'sha256:aa',
              activities: { [name]: { contractHash: 'h', implementationRevision: 'r' } },
            },
          },
        }),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(Object.keys(result.manifest.workflows)).toEqual([name]);
      expect(result.manifest.workflows[name]?.contractHash).toBe('sha256:aa');
      expect(Object.keys(result.manifest.workflows[name]!.activities)).toEqual([name]);
    },
  );

  it('does not pollute Object.prototype through a __proto__ capability key', () => {
    const result = parseWorkerManifest(
      JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>,
    );

    expect(result.ok).toBe(false);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('keeps a __proto__ capability key as data', () => {
    const capabilities = JSON.parse('{"__proto__":{"nested":true}}') as Record<string, unknown>;
    const result = parseWorkerManifest(manifestInput({ capabilities }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.manifest.capabilities)).toEqual(['__proto__']);
    expect(({} as Record<string, unknown>)['nested']).toBeUndefined();
  });

  it('accepts an identifier exactly at the byte ceiling', () => {
    const result = parseWorkerManifest(
      manifestInput({ sdkVersion: asciiOfLength(MAX_MANIFEST_IDENTIFIER_BYTES) }),
    );

    expect(result.ok).toBe(true);
  });
});

describe('parseWorkerManifest — structural rejection', () => {
  it.each([
    ['null', null],
    ['a string', 'manifest'],
    ['an array', []],
    ['a number', 7],
  ])('rejects %s', (_label, value) => {
    expect(expectRejection(value).reason).toBe('not_an_object');
  });

  it('rejects an unknown manifest version before checking any other field', () => {
    const failure = expectRejection({ manifestVersion: 99 });

    expect(failure.reason).toBe('unsupported_manifest_version');
  });

  it('rejects a missing manifest version', () => {
    expect(expectRejection({}).reason).toBe('unsupported_manifest_version');
  });
});

describe('parseWorkerManifest — scalar field rejection', () => {
  it.each([
    ['a non-number protocolVersion', { protocolVersion: '2' }, 'manifest.protocolVersion'],
    ['a fractional protocolVersion', { protocolVersion: 2.5 }, 'manifest.protocolVersion'],
    ['a zero protocolVersion', { protocolVersion: 0 }, 'manifest.protocolVersion'],
    [
      'an unsafe protocolVersion',
      { protocolVersion: Number.MAX_SAFE_INTEGER + 2 },
      'manifest.protocolVersion',
    ],
    ['a missing sdkVersion', { sdkVersion: undefined }, 'manifest.sdkVersion'],
    ['an empty sdkVersion', { sdkVersion: '' }, 'manifest.sdkVersion'],
    ['a non-string sdkVersion', { sdkVersion: 3 }, 'manifest.sdkVersion'],
  ])('rejects %s', (_label, overrides, path) => {
    const failure = expectRejection(manifestInput(overrides));

    expect(failure.reason).toBe('invalid_field');
    expect(failure.path).toBe(path);
  });

  it('rejects an oversized sdkVersion', () => {
    const failure = expectRejection(
      manifestInput({ sdkVersion: asciiOfLength(MAX_MANIFEST_IDENTIFIER_BYTES + 1) }),
    );

    expect(failure.reason).toBe('identifier_too_long');
    expect(failure.path).toBe('manifest.sdkVersion');
  });

  it('measures identifier limits in UTF-8 bytes, not UTF-16 code units', () => {
    // Each emoji is one code point but four UTF-8 bytes, so a string well
    // under the ceiling by `.length` is well over it by bytes.
    const emoji = '🙂'.repeat(MAX_MANIFEST_IDENTIFIER_BYTES / 4 + 1);
    const failure = expectRejection(manifestInput({ sdkVersion: emoji }));

    expect(emoji.length).toBeLessThan(MAX_MANIFEST_IDENTIFIER_BYTES);
    expect(failure.reason).toBe('identifier_too_long');
  });
});

describe('parseWorkerManifest — runtime rejection', () => {
  it.each([
    ['a non-object runtime', { runtime: 'bun' }, 'manifest.runtime', 'invalid_field'],
    ['an array runtime', { runtime: [] }, 'manifest.runtime', 'invalid_field'],
    [
      'a missing runtime name',
      { runtime: { version: '1' } },
      'manifest.runtime.name',
      'invalid_field',
    ],
    [
      'an empty runtime name',
      { runtime: { name: '', version: '1' } },
      'manifest.runtime.name',
      'invalid_field',
    ],
    [
      'a non-string runtime version',
      { runtime: { name: 'bun', version: 1 } },
      'manifest.runtime.version',
      'invalid_field',
    ],
    [
      'a missing runtime version',
      { runtime: { name: 'bun' } },
      'manifest.runtime.version',
      'invalid_field',
    ],
  ])('rejects %s', (_label, overrides, path, reason) => {
    const failure = expectRejection(manifestInput(overrides));

    expect(failure.reason).toBe(reason);
    expect(failure.path).toBe(path);
  });

  it('rejects an oversized runtime name', () => {
    const failure = expectRejection(
      manifestInput({
        runtime: { name: asciiOfLength(MAX_MANIFEST_IDENTIFIER_BYTES + 1), version: '1' },
      }),
    );

    expect(failure.reason).toBe('identifier_too_long');
    expect(failure.path).toBe('manifest.runtime.name');
  });

  it('rejects an oversized runtime version', () => {
    const failure = expectRejection(
      manifestInput({
        runtime: { name: 'bun', version: asciiOfLength(MAX_MANIFEST_IDENTIFIER_BYTES + 1) },
      }),
    );

    expect(failure.reason).toBe('identifier_too_long');
    expect(failure.path).toBe('manifest.runtime.version');
  });
});

describe('parseWorkerManifest — deployment rejection', () => {
  it.each([
    ['a non-object deployment', { deployment: 'billing' }, 'manifest.deployment'],
    [
      'a missing deployment name',
      { deployment: { buildId: 'b', artifactDigest: 'd' } },
      'manifest.deployment.name',
    ],
    [
      'a missing buildId',
      { deployment: { name: 'n', artifactDigest: 'd' } },
      'manifest.deployment.buildId',
    ],
    [
      'a missing artifactDigest',
      { deployment: { name: 'n', buildId: 'b' } },
      'manifest.deployment.artifactDigest',
    ],
    [
      'an empty artifactDigest',
      { deployment: { name: 'n', buildId: 'b', artifactDigest: '' } },
      'manifest.deployment.artifactDigest',
    ],
  ])('rejects %s', (_label, overrides, path) => {
    const failure = expectRejection(manifestInput(overrides));

    expect(failure.reason).toBe('invalid_field');
    expect(failure.path).toBe(path);
  });

  it('rejects an oversized buildId', () => {
    const failure = expectRejection(
      manifestInput({
        deployment: {
          name: 'n',
          buildId: asciiOfLength(MAX_MANIFEST_IDENTIFIER_BYTES + 1),
          artifactDigest: 'd',
        },
      }),
    );

    expect(failure.reason).toBe('identifier_too_long');
    expect(failure.path).toBe('manifest.deployment.buildId');
  });
});

describe('parseWorkerManifest — workflow rejection', () => {
  it('rejects a non-object workflows record', () => {
    const failure = expectRejection(manifestInput({ workflows: [] }));

    expect(failure.reason).toBe('invalid_field');
    expect(failure.path).toBe('manifest.workflows');
  });

  it('rejects more workflows than the ceiling allows', () => {
    const workflows: Record<string, unknown> = {};
    for (let index = 0; index <= MAX_MANIFEST_WORKFLOW_COUNT; index++) {
      workflows[`w${String(index)}`] = validWorkflow();
    }

    const failure = expectRejection(manifestInput({ workflows }));

    expect(failure.reason).toBe('too_many_workflows');
    expect(failure.path).toBe('manifest.workflows');
  });

  it('rejects an empty workflow key', () => {
    const failure = expectRejection(manifestInput({ workflows: { '': validWorkflow() } }));

    expect(failure.reason).toBe('invalid_field');
  });

  it('rejects an oversized workflow key', () => {
    const failure = expectRejection(
      manifestInput({
        workflows: { [asciiOfLength(MAX_MANIFEST_IDENTIFIER_BYTES + 1)]: validWorkflow() },
      }),
    );

    expect(failure.reason).toBe('identifier_too_long');
  });

  it('rejects a non-object workflow entry', () => {
    const failure = expectRejection(manifestInput({ workflows: { checkout: 'nope' } }));

    expect(failure.reason).toBe('invalid_field');
    expect(failure.path).toBe('manifest.workflows.checkout');
  });

  it.each([
    ['workflowVersion', 'manifest.workflows.checkout.workflowVersion'],
    ['workflowRevision', 'manifest.workflows.checkout.workflowRevision'],
    ['contractHash', 'manifest.workflows.checkout.contractHash'],
  ])('rejects a workflow missing %s', (field, path) => {
    const workflow = validWorkflow();
    delete workflow[field];

    const failure = expectRejection(manifestInput({ workflows: { checkout: workflow } }));

    expect(failure.reason).toBe('invalid_field');
    expect(failure.path).toBe(path);
  });

  it('rejects a non-object activities record', () => {
    const failure = expectRejection(
      manifestInput({ workflows: { checkout: { ...validWorkflow(), activities: 'none' } } }),
    );

    expect(failure.reason).toBe('invalid_field');
    expect(failure.path).toBe('manifest.workflows.checkout.activities');
  });

  it('rejects more activities than the ceiling allows', () => {
    const activities: Record<string, unknown> = {};
    for (let index = 0; index <= MAX_MANIFEST_ACTIVITY_COUNT; index++) {
      activities[`a${String(index)}`] = { contractHash: 'h', implementationRevision: 'r' };
    }

    const failure = expectRejection(
      manifestInput({ workflows: { checkout: validWorkflow(activities) } }),
    );

    expect(failure.reason).toBe('too_many_activities');
    expect(failure.path).toBe('manifest.workflows.checkout.activities');
  });

  it('rejects an empty activity key', () => {
    const failure = expectRejection(
      manifestInput({
        workflows: {
          checkout: validWorkflow({ '': { contractHash: 'h', implementationRevision: 'r' } }),
        },
      }),
    );

    expect(failure.reason).toBe('invalid_field');
  });

  it('rejects an oversized activity key', () => {
    const failure = expectRejection(
      manifestInput({
        workflows: {
          checkout: validWorkflow({
            [asciiOfLength(MAX_MANIFEST_IDENTIFIER_BYTES + 1)]: {
              contractHash: 'h',
              implementationRevision: 'r',
            },
          }),
        },
      }),
    );

    expect(failure.reason).toBe('identifier_too_long');
  });

  it('rejects a non-object activity entry', () => {
    const failure = expectRejection(
      manifestInput({ workflows: { checkout: validWorkflow({ charge: 5 }) } }),
    );

    expect(failure.reason).toBe('invalid_field');
    expect(failure.path).toBe('manifest.workflows.checkout.activities.charge');
  });

  it.each([
    ['contractHash', 'manifest.workflows.checkout.activities.charge.contractHash'],
    [
      'implementationRevision',
      'manifest.workflows.checkout.activities.charge.implementationRevision',
    ],
  ])('rejects an activity missing %s', (field, path) => {
    const activity: Record<string, unknown> = { contractHash: 'h', implementationRevision: 'r' };
    delete activity[field];

    const failure = expectRejection(
      manifestInput({ workflows: { checkout: validWorkflow({ charge: activity }) } }),
    );

    expect(failure.reason).toBe('invalid_field');
    expect(failure.path).toBe(path);
  });
});

describe('parseWorkerManifest — capability rejection', () => {
  it('rejects a non-object capabilities record', () => {
    const failure = expectRejection(manifestInput({ capabilities: [] }));

    expect(failure.reason).toBe('invalid_field');
    expect(failure.path).toBe('manifest.capabilities');
  });

  it('rejects more capabilities than the ceiling allows', () => {
    const capabilities: Record<string, unknown> = {};
    for (let index = 0; index <= MAX_MANIFEST_CAPABILITY_COUNT; index++) {
      capabilities[`c${String(index)}`] = true;
    }

    const failure = expectRejection(manifestInput({ capabilities }));

    expect(failure.reason).toBe('too_many_capabilities');
  });

  it('rejects a capability value JSON cannot represent', () => {
    const failure = expectRejection(manifestInput({ capabilities: { fn: () => undefined } }));

    expect(failure.reason).toBe('invalid_capability_value');
    expect(failure.path).toBe('manifest.capabilities.fn');
  });

  it('rejects negative zero, which JSON serialization would erase', () => {
    const failure = expectRejection(manifestInput({ capabilities: { offset: -0 } }));

    expect(failure.reason).toBe('invalid_capability_value');
  });

  it('rejects a capability nested deeper than the ceiling', () => {
    let nested: unknown = 'leaf';
    for (let depth = 0; depth <= MAX_MANIFEST_CAPABILITY_DEPTH; depth++) {
      nested = { inner: nested };
    }

    const failure = expectRejection(manifestInput({ capabilities: { deep: nested } }));

    expect(failure.reason).toBe('capability_too_deep');
  });

  it('rejects deep nesting reached through arrays', () => {
    let nested: unknown = 'leaf';
    for (let depth = 0; depth <= MAX_MANIFEST_CAPABILITY_DEPTH; depth++) {
      nested = [nested];
    }

    const failure = expectRejection(manifestInput({ capabilities: { deep: nested } }));

    expect(failure.reason).toBe('capability_too_deep');
  });

  it('rejects an oversized capability string', () => {
    const failure = expectRejection(
      manifestInput({
        capabilities: { note: asciiOfLength(MAX_MANIFEST_CAPABILITY_STRING_BYTES + 1) },
      }),
    );

    expect(failure.reason).toBe('capability_string_too_long');
    expect(failure.path).toBe('manifest.capabilities.note');
  });

  it('rejects an oversized string nested inside a capability array', () => {
    const failure = expectRejection(
      manifestInput({
        capabilities: {
          notes: [asciiOfLength(MAX_MANIFEST_CAPABILITY_STRING_BYTES + 1)],
        },
      }),
    );

    expect(failure.reason).toBe('capability_string_too_long');
    expect(failure.path).toBe('manifest.capabilities.notes[0]');
  });

  it('rejects an oversized string nested inside a capability object', () => {
    const failure = expectRejection(
      manifestInput({
        capabilities: {
          meta: { note: asciiOfLength(MAX_MANIFEST_CAPABILITY_STRING_BYTES + 1) },
        },
      }),
    );

    expect(failure.reason).toBe('capability_string_too_long');
    expect(failure.path).toBe('manifest.capabilities.meta.note');
  });

  it('accepts a capability string exactly at the ceiling', () => {
    const result = parseWorkerManifest(
      manifestInput({
        capabilities: { note: asciiOfLength(MAX_MANIFEST_CAPABILITY_STRING_BYTES) },
      }),
    );

    expect(result.ok).toBe(true);
  });

  it('accepts an array capability whose every element is within bounds', () => {
    const result = parseWorkerManifest(
      manifestInput({ capabilities: { queues: ['default', 'gpu'], slots: [1, 2, 3] } }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.capabilities['queues']).toEqual(['default', 'gpu']);
  });

  it('accepts nesting exactly at the depth ceiling', () => {
    let nested: unknown = 'leaf';
    for (let depth = 1; depth < MAX_MANIFEST_CAPABILITY_DEPTH; depth++) {
      nested = { inner: nested };
    }

    expect(parseWorkerManifest(manifestInput({ capabilities: { deep: nested } })).ok).toBe(true);
  });
});

describe('parseWorkerManifest — normalized size', () => {
  it('rejects a manifest whose canonical form exceeds the byte ceiling', () => {
    const workflows: Record<string, unknown> = {};
    // Each workflow contributes several hundred canonical bytes, so a few
    // hundred of them clear the ceiling while staying under the count limit.
    for (let index = 0; index < MAX_MANIFEST_WORKFLOW_COUNT; index++) {
      workflows[`workflow-${String(index)}-${asciiOfLength(400)}`] = validWorkflow({
        charge: { contractHash: asciiOfLength(400), implementationRevision: asciiOfLength(400) },
      });
    }

    const failure = expectRejection(manifestInput({ workflows }));

    expect(failure.reason).toBe('manifest_too_large');
    expect(failure.message).toContain(String(MAX_NORMALIZED_MANIFEST_BYTES));
  });
});

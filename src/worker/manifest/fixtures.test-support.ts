/**
 * Shared manifest fixtures for the manifest-core tests.
 *
 * Only the harness lives here. Each test keeps its own specific input and
 * assertion local so a bound-checking test still reads as a statement about
 * that one bound.
 *
 * @module worker/manifest/fixtures.test-support
 */

import type { WorkerManifest } from './types.ts';
import { WORKER_MANIFEST_VERSION } from './types.ts';

/** A minimal manifest that advertises no workflows and no capabilities. */
export function emptyManifest(overrides: Partial<WorkerManifest> = {}): WorkerManifest {
  return {
    manifestVersion: WORKER_MANIFEST_VERSION,
    protocolVersion: 2,
    sdkVersion: '0.18.0',
    runtime: { name: 'bun', version: '1.3.14' },
    deployment: { name: 'billing', buildId: 'b3', artifactDigest: 'sha256:41d0' },
    workflows: {},
    capabilities: {},
    ...overrides,
  };
}

/** A manifest advertising one workflow with one activity. */
export function singleWorkflowManifest(overrides: Partial<WorkerManifest> = {}): WorkerManifest {
  return emptyManifest({
    workflows: {
      checkout: {
        workflowVersion: '1.0.0',
        workflowRevision: 'rev-8',
        contractHash: 'sha256:aa',
        activities: {
          charge: { contractHash: 'sha256:bb', implementationRevision: 'r1' },
        },
      },
    },
    ...overrides,
  });
}

/** The same manifest shape as a plain JSON-compatible object literal. */
export function manifestInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...emptyManifest(), ...overrides };
}

/** Build a string of exactly `bytes` ASCII characters. */
export function asciiOfLength(bytes: number): string {
  return 'a'.repeat(bytes);
}

import { describe, expect, test } from 'bun:test';

import { assertSnapshotRef, snapshotVersionFor } from './prepare-snapshot.ts';

const sha = 'a'.repeat(40);
const actor = 'lost-gradient-mirror-sync[bot]';
const mirrorBranch = 'refs/heads/mirror-sync-deadbeefcafe-12345678-1234-1234-1234-123456789abc';

describe('snapshot publication guards', () => {
  test('derives a deterministic prerelease from the source version and run identity', () => {
    expect(snapshotVersionFor({ sourceVersion: '0.27.2', runId: '12345', runAttempt: '2' })).toBe(
      '0.27.2-next.12345.2',
    );
  });

  test('rejects unstable source versions and invalid run identities', () => {
    expect(() =>
      snapshotVersionFor({ sourceVersion: '0.27.2-next.1', runId: '1', runAttempt: '1' }),
    ).toThrow('stable semver');
    expect(() =>
      snapshotVersionFor({ sourceVersion: '0.27.2', runId: '0', runAttempt: '1' }),
    ).toThrow('positive integer');
  });

  test('requires the dispatched branch to resolve to the expected commit', () => {
    expect(() =>
      assertSnapshotRef({
        actor,
        expectedSha: sha,
        githubSha: sha,
        headSha: sha,
        ref: 'refs/heads/main',
      }),
    ).not.toThrow();
    expect(() =>
      assertSnapshotRef({
        actor,
        expectedSha: sha,
        githubSha: sha,
        headSha: 'b'.repeat(40),
        ref: 'refs/heads/main',
      }),
    ).toThrow('Checked-out commit mismatch');
    expect(() =>
      assertSnapshotRef({
        actor,
        expectedSha: sha,
        githubSha: sha,
        headSha: sha,
        ref: mirrorBranch,
      }),
    ).not.toThrow();
  });

  test('rejects an actor or ref outside the mirror dispatch contract', () => {
    expect(() =>
      assertSnapshotRef({
        actor: 'attacker',
        expectedSha: sha,
        githubSha: sha,
        headSha: sha,
        ref: 'refs/heads/main',
      }),
    ).toThrow('dispatch actor');
    expect(() =>
      assertSnapshotRef({
        actor,
        expectedSha: sha,
        githubSha: sha,
        headSha: sha,
        ref: 'refs/heads/evil',
      }),
    ).toThrow('not mirror-controlled');
    expect(() =>
      assertSnapshotRef({
        actor,
        expectedSha: sha,
        githubSha: sha,
        headSha: sha,
        ref: 'refs/tags/v0.27.2',
      }),
    ).toThrow('not mirror-controlled');
    expect(() =>
      assertSnapshotRef({
        actor,
        expectedSha: sha,
        githubSha: 'b'.repeat(40),
        headSha: sha,
        ref: 'refs/heads/main',
      }),
    ).toThrow('Dispatch SHA mismatch');
  });
});

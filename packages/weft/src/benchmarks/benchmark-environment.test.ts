import { afterEach, describe, expect, it } from 'bun:test';

import { isConstrainedCodexRunner, isGitHubActionsRunner } from './benchmark-environment.ts';

const originalCodexCi = process.env['CODEX_CI'];
const originalGitHubActions = process.env['GITHUB_ACTIONS'];

afterEach(() => {
  if (originalCodexCi === undefined) {
    delete process.env['CODEX_CI'];
  } else {
    process.env['CODEX_CI'] = originalCodexCi;
  }

  if (originalGitHubActions === undefined) {
    delete process.env['GITHUB_ACTIONS'];
  } else {
    process.env['GITHUB_ACTIONS'] = originalGitHubActions;
  }
});

describe('benchmark environment', () => {
  it('detects constrained Codex runners from CODEX_CI', () => {
    process.env['CODEX_CI'] = '1';
    expect(isConstrainedCodexRunner()).toBe(true);

    process.env['CODEX_CI'] = '0';
    expect(isConstrainedCodexRunner()).toBe(false);
  });

  it('detects GitHub Actions runners from GITHUB_ACTIONS', () => {
    process.env['GITHUB_ACTIONS'] = 'true';
    expect(isGitHubActionsRunner()).toBe(true);

    process.env['GITHUB_ACTIONS'] = 'false';
    expect(isGitHubActionsRunner()).toBe(false);
  });
});

import { describe, expect, it } from 'bun:test';

import {
  normalizePullRequestTitle,
  runPullRequestTitleCli,
  validatePullRequestTitle,
} from './pull-request-title.ts';

describe('normalizePullRequestTitle', () => {
  it('leaves a valid plain title unchanged', () => {
    const result = normalizePullRequestTitle('Add worker heartbeat persistence');

    expect(result.normalizedTitle).toBe('Add worker heartbeat persistence');
    expect(result.changed).toBe(false);
    expect(result.safeToAutofix).toBe(true);
  });

  it('preserves a valid Linear ticket prefix', () => {
    const result = normalizePullRequestTitle('DEP-123: Add worker heartbeat persistence');

    expect(result.normalizedTitle).toBe('DEP-123: Add worker heartbeat persistence');
    expect(result.changed).toBe(false);
  });

  it('normalizes the observed slug-plus-markdown failure mode', () => {
    const result = normalizePullRequestTitle(
      'asyncdisposablestack-used-in-server-setup-all-serv: **`AsyncDisposableStack` used in server setup.** All server resources cleaned up in reverse order on shutdown.',
    );

    expect(result.normalizedTitle).toBe('AsyncDisposableStack used in server setup');
    expect(result.changed).toBe(true);
    expect(result.safeToAutofix).toBe(true);
  });

  it('strips conventional-commit prefixes before validation', () => {
    const result = normalizePullRequestTitle(
      'feat: complete agent cost enforcement with budget tracking',
    );

    expect(result.normalizedTitle).toBe('Complete agent cost enforcement with budget tracking');
    expect(result.safeToAutofix).toBe(true);
  });

  it('keeps the ticket prefix when repairing a malformed title', () => {
    const result = normalizePullRequestTitle(
      'DEP-123: long-poll-fallback-for-non-websocket-environments-: **Long-poll fallback for non-WebSocket environments.** `GET /v1/tasks/:queue` with timeout.',
    );

    expect(result.normalizedTitle).toBe(
      'DEP-123: Long-poll fallback for non-WebSocket environments',
    );
    expect(result.safeToAutofix).toBe(true);
  });

  it('refuses to invent a title from an ambiguous slug-only value', () => {
    const result = normalizePullRequestTitle('ralph-feature-branch:');

    expect(result.normalizedTitle).toBeNull();
    expect(result.changed).toBe(false);
    expect(result.safeToAutofix).toBe(false);
  });

  it('keeps changed aligned with the returned normalized title', () => {
    const result = normalizePullRequestTitle('feat: 1.2.3');

    expect(result.normalizedTitle).toBeNull();
    expect(result.changed).toBe(false);
    expect(result.safeToAutofix).toBe(false);
    expect(result.issues).toContain(
      'PR title must start with an uppercase letter after any optional Linear ticket prefix.',
    );
  });

  it('treats decimal version numbers as part of the same sentence', () => {
    const result = normalizePullRequestTitle('release-branch: release 1.2.3. Follow-up details.');

    expect(result.normalizedTitle).toBe('Release 1.2.3');
    expect(result.safeToAutofix).toBe(true);
  });

  it('extracts the first plain sentence when the title contains follow-up details', () => {
    const result = normalizePullRequestTitle('Fix worker reconnect. Keep-alive follow-up.');

    expect(result.normalizedTitle).toBe('Fix worker reconnect');
    expect(result.safeToAutofix).toBe(true);
  });

  it('ignores non-terminal punctuation before the actual sentence break', () => {
    const result = normalizePullRequestTitle('Fix worker reconnect... Keep-alive follow-up.');

    expect(result.normalizedTitle).toBe('Fix worker reconnect');
    expect(result.safeToAutofix).toBe(true);
  });

  it('returns an empty normalized base title unchanged when cleanup removes everything', () => {
    const result = normalizePullRequestTitle('**`   `**');

    expect(result.normalizedTitle).toBeNull();
    expect(result.issues).toContain('Unable to derive a safe PR title.');
  });
});

describe('validatePullRequestTitle', () => {
  it('accepts a valid plain title', () => {
    const result = validatePullRequestTitle('Add worker heartbeat persistence');

    expect(result).toEqual({ valid: true, issues: [] });
  });

  it('rejects markdown, branch slugs, and multi-sentence titles', () => {
    const result = validatePullRequestTitle(
      'long-poll-fallback-for-non-websocket-environments-: **Long-poll fallback.** Extra detail.',
    );

    expect(result.valid).toBe(false);
    expect(result.issues).toContain('PR title must not start with a branch-slug prefix.');
    expect(result.issues).toContain('PR title must not contain Markdown emphasis or inline code.');
    expect(result.issues).toContain(
      'PR title must be a single concise sentence fragment, not a multi-sentence dump.',
    );
  });

  it('rejects conventional-commit prefixes', () => {
    const result = validatePullRequestTitle('fix: add worker heartbeat persistence');

    expect(result.valid).toBe(false);
    expect(result.issues).toContain(
      'PR title must not start with a conventional-commit prefix like feat: or fix:.',
    );
  });

  it('rejects lowercase titles after an optional ticket prefix', () => {
    const result = validatePullRequestTitle('DEP-123: add worker heartbeat persistence');

    expect(result.valid).toBe(false);
    expect(result.issues).toContain(
      'PR title must start with an uppercase letter after any optional Linear ticket prefix.',
    );
  });

  it('reports trailing punctuation distinctly from multi-sentence titles', () => {
    const result = validatePullRequestTitle('Fix the bug.');

    expect(result.valid).toBe(false);
    expect(result.issues).toContain('PR title must not end with trailing punctuation.');
    expect(result.issues).not.toContain(
      'PR title must be a single concise sentence fragment, not a multi-sentence dump.',
    );
  });

  it('does not report trailing punctuation for markdown-only cleanup', () => {
    const result = validatePullRequestTitle('Fix **the** bug');

    expect(result.valid).toBe(false);
    expect(result.issues).toContain('PR title must not contain Markdown emphasis or inline code.');
    expect(result.issues).not.toContain('PR title must not end with trailing punctuation.');
  });

  it('rejects empty titles', () => {
    expect(validatePullRequestTitle('   ')).toEqual({
      valid: false,
      issues: ['PR title must not be empty.'],
    });
  });

  it('rejects surrounding whitespace and newlines', () => {
    const result = validatePullRequestTitle(' Add worker heartbeat persistence\n');

    expect(result.valid).toBe(false);
    expect(result.issues).toContain('PR title must not start or end with whitespace.');
    expect(result.issues).toContain('PR title must be a single line.');
  });

  it('rejects standalone branch slugs', () => {
    const result = validatePullRequestTitle('feature-worker-reconnect');

    expect(result.valid).toBe(false);
    expect(result.issues).toContain('PR title must not be just a branch slug.');
    expect(result.issues).toContain(
      'PR title must start with an uppercase letter after any optional Linear ticket prefix.',
    );
  });

  it('rejects HTML fragments', () => {
    const result = validatePullRequestTitle('<b>Fix worker reconnect</b>');

    expect(result.valid).toBe(false);
    expect(result.issues).toContain('PR title must not contain HTML or HTML comments.');
  });
});

describe('pr-title CLI', () => {
  it('runs normalize in-process for coverage attribution', () => {
    const result = runPullRequestTitleCli([
      'normalize',
      '--title',
      'feat: complete agent cost enforcement with budget tracking',
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toEqual([]);
    expect(JSON.parse(result.stdout[0]).normalizedTitle).toBe(
      'Complete agent cost enforcement with budget tracking',
    );
  });

  it('runs validate in-process for valid titles', () => {
    const result = runPullRequestTitleCli([
      'validate',
      '--title',
      'Add worker heartbeat persistence',
    ]);

    expect(result).toEqual({
      stdout: ['Add worker heartbeat persistence'],
      stderr: [],
      exitCode: 0,
    });
  });

  it('accepts the equals-sign flag form in-process', () => {
    const result = runPullRequestTitleCli(['validate', '--title=Add worker heartbeat persistence']);

    expect(result).toEqual({
      stdout: ['Add worker heartbeat persistence'],
      stderr: [],
      exitCode: 0,
    });
  });

  it('returns usage for missing arguments in-process', () => {
    const result = runPullRequestTitleCli(['normalize']);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toEqual([
      'Usage: bun run scripts/pr-title.ts <normalize|validate> --title "Your PR title"',
    ]);
  });

  it('returns usage for unknown commands in-process', () => {
    const result = runPullRequestTitleCli(['ship', '--title', 'Add worker heartbeat persistence']);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toEqual([
      'Usage: bun run scripts/pr-title.ts <normalize|validate> --title "Your PR title"',
    ]);
  });

  it('returns validation issues in-process for invalid titles', () => {
    const result = runPullRequestTitleCli([
      'validate',
      '--title',
      'fix: add worker heartbeat persistence',
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toContain(
      '- PR title must not start with a conventional-commit prefix like feat: or fix:.',
    );
  });

  it('treats unknown commands as usage errors in-process', () => {
    const result = runPullRequestTitleCli([
      'unknown',
      '--title',
      'Add worker heartbeat persistence',
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toEqual([
      'Usage: bun run scripts/pr-title.ts <normalize|validate> --title "Your PR title"',
    ]);
  });

  function runPrTitleCli(...arguments_: string[]) {
    return Bun.spawnSync(['bun', 'run', 'scripts/pr-title.ts', ...arguments_], {
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
  }

  it('normalizes titles from the command line', () => {
    const result = runPrTitleCli(
      'normalize',
      '--title',
      'feat: complete agent cost enforcement with budget tracking',
    );

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(new TextDecoder().decode(result.stdout));
    expect(parsed.normalizedTitle).toBe('Complete agent cost enforcement with budget tracking');
  });

  it('prints the trimmed title for valid command-line validation', () => {
    const result = runPrTitleCli('validate', '--title', 'Add worker heartbeat persistence');

    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout).trim()).toBe('Add worker heartbeat persistence');
  });

  it('prints usage and exits non-zero when required CLI arguments are missing', () => {
    const result = runPrTitleCli('normalize');

    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stderr)).toContain('Usage: bun run scripts/pr-title.ts');
  });

  it('prints validation issues and exits non-zero for invalid CLI titles', () => {
    const result = runPrTitleCli('validate', '--title', 'fix: add worker heartbeat persistence');

    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stderr)).toContain(
      'PR title must not start with a conventional-commit prefix like feat: or fix:.',
    );
  });
});

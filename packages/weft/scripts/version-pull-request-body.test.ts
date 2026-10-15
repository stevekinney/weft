import { describe, expect, test } from 'bun:test';

import {
  automaticPublishClause,
  rewriteVersionPullRequestBody,
  VersionPullRequestBodyError,
} from './version-pull-request-body.ts';

// The header changesets/action v2.1.2 writes when it has no publish script (src/run.ts).
const generated =
  "This PR was opened by the [Changesets release](https://github.com/changesets/action) GitHub action. When you're ready to do a release, you can merge this and publish to npm yourself or [setup this action to publish automatically](https://github.com/changesets/action#with-publishing). If you're not ready to do a release yet, that's fine, whenever you add more changesets to main, this PR will be updated.\n\n# Releases\n\n## @lostgradient/weft@0.27.18\n";

describe('rewriteVersionPullRequestBody', () => {
  test('replaces the manual-publish instruction with the automatic publish that merging triggers', () => {
    const rewritten = rewriteVersionPullRequestBody(generated);

    expect(rewritten).not.toContain('publish to npm yourself');
    expect(rewritten).toContain(automaticPublishClause);
    expect(rewritten).toContain('# Releases\n\n## @lostgradient/weft@0.27.18');
    expect(rewritten).toContain('publishes the release**. If');
    expect(rewritten).not.toContain('.**.');
  });

  test('leaves an already rewritten body unchanged', () => {
    const once = rewriteVersionPullRequestBody(generated);

    expect(rewriteVersionPullRequestBody(once)).toBe(once);
  });

  test('fails loudly when the action no longer writes the sentence it replaces', () => {
    expect(() => rewriteVersionPullRequestBody('# Releases\n')).toThrow(
      VersionPullRequestBodyError,
    );
  });
});

describe('version-pull-request-body CLI', () => {
  test('rewrites standard input to standard output', async () => {
    const child = Bun.spawn(['bun', 'run', `${import.meta.dir}/version-pull-request-body.ts`], {
      stdin: new Blob([generated]),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain(automaticPublishClause);
  });

  test('exits non-zero with the reason when the sentence is missing', async () => {
    const child = Bun.spawn(['bun', 'run', `${import.meta.dir}/version-pull-request-body.ts`], {
      stdin: new Blob(['no header']),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('changesets/action changed its wording');
  });
});

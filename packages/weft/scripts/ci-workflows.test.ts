import { describe, expect, it } from 'bun:test';

import { BROWSER_SMOKE_TEST_PATHS } from './husky/run-tests.ts';

const repositoryRoot = new URL('../../../', import.meta.url);

async function readWorkflow(name: string): Promise<string> {
  return Bun.file(new URL(`.github/workflows/${name}`, repositoryRoot)).text();
}

describe('coverage workflow gates', () => {
  it('uses Bun 1.4 isolated installs in CI and release jobs', async () => {
    for (const workflowName of ['ci.yaml', 'release.yaml']) {
      const workflow = await readWorkflow(workflowName);
      const installs = workflow.match(/bun install --frozen-lockfile[^\n]*/g) ?? [];
      const bunVersions = workflow.match(/bun-version: [^\n]*/g) ?? [];

      expect(installs.length).toBeGreaterThan(0);
      expect(installs.every((install) => install.endsWith('--linker=isolated'))).toBe(true);
      expect(bunVersions.length).toBeGreaterThan(0);
      expect(bunVersions.every((version) => version === 'bun-version: 1.4.0')).toBe(true);
    }
  });

  it('runs adjusted coverage for pull requests and merge groups without replacing ordinary tests', async () => {
    const workflow = await readWorkflow('ci.yaml');

    expect(workflow).toContain('pull_request:');
    expect(workflow).toContain('merge_group:');
    expect(workflow).toMatch(/\n  coverage:\n[\s\S]*?bun run test:coverage/);
    expect(workflow).toMatch(/\n  test:\n[\s\S]*?bun test --bail/);
  });

  it('uses remote caching for deterministic jobs only', async () => {
    const workflow = await readWorkflow('ci.yaml');
    const cacheTokens =
      workflow.match(/TURBO_TOKEN: (?:\$\{\{ secrets\.TURBO_TOKEN \}\}|"")/g) ?? [];
    const cacheTeams = workflow.match(/TURBO_TEAM: kinney/g) ?? [];

    expect(cacheTokens).toHaveLength(7);
    expect(cacheTeams).toHaveLength(7);
    expect(workflow).not.toMatch(/\n  coverage:\n(?:(?!\n {2}\S).)*?TURBO_TOKEN:/s);
  });

  it('keeps the ordinary CI test job aligned with the browser-smoke exclusion boundary', async () => {
    const workflow = await readWorkflow('ci.yaml');

    for (const testPath of BROWSER_SMOKE_TEST_PATHS) {
      expect(workflow).toContain(`--path-ignore-patterns '${testPath}'`);
    }
  });

  it('blocks npm publication on adjusted coverage without adding coverage to prepack', async () => {
    const workflow = await readWorkflow('release.yaml');
    const runGates = await Bun.file(new URL('run-gates.ts', import.meta.url)).text();

    expect(workflow).toMatch(/\n  coverage:\n[\s\S]*?bun run test:coverage/);
    expect(workflow).toContain('needs: [verify, validate, coverage]');
    expect(runGates).not.toMatch(/prepack:[\s\S]*script: 'test:coverage'/);
  });
});

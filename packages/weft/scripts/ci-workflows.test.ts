import { describe, expect, it } from 'bun:test';

import { BROWSER_SMOKE_TEST_PATHS } from './husky/run-tests.ts';

const repositoryRoot = new URL('../../../', import.meta.url);

async function readWorkflow(name: string): Promise<string> {
  return Bun.file(new URL(`.github/workflows/${name}`, repositoryRoot)).text();
}

function workflowJob(workflow: string, name: string): string {
  const heading = `\n  ${name}:\n`;
  const start = workflow.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);

  const contentStart = start + heading.length;
  const remaining = workflow.slice(contentStart);
  const nextJob = remaining.search(/\n  [a-z][a-z0-9-]*:\n/);
  return nextJob === -1 ? remaining : remaining.slice(0, nextJob);
}

function workflowJobNames(workflow: string): string[] {
  const jobs = workflow.slice(workflow.indexOf('\njobs:\n'));
  return [...jobs.matchAll(/^  ([a-z][a-z0-9-]*):$/gm)].map((match) => match[1] as string);
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
    expect(workflowJob(workflow, 'coverage')).toContain('bun run test:coverage');
    expect(workflowJob(workflow, 'test')).toContain('bun test --bail');
  });

  it('uses remote caching for deterministic jobs only', async () => {
    const workflow = await readWorkflow('ci.yaml');
    const cachedJobs = new Map([
      ['lint', 'bunx turbo run lint --filter=@lostgradient/weft'],
      ['typecheck', 'bunx turbo run typecheck --filter=@lostgradient/weft'],
      ['build', 'bunx turbo run build --filter=@lostgradient/weft'],
      ['ui-lint', 'bunx turbo run lint --filter=@lostgradient/weft-ui'],
      ['ui-typecheck', 'bunx turbo run typecheck --filter=@lostgradient/weft-ui'],
      ['ui-build', 'bunx turbo run build --filter=@lostgradient/weft-ui'],
      ['ui-format-check', 'bunx turbo run format:check --filter=@lostgradient/weft-ui'],
    ]);

    for (const [name, command] of cachedJobs) {
      const job = workflowJob(workflow, name);
      expect(job).toContain(command);
      expect(job).toMatch(/TURBO_TOKEN: (?:\$\{\{ secrets\.TURBO_TOKEN \}\}|"")/);
      expect(job).toContain('TURBO_TEAM: kinney');
    }

    for (const name of workflowJobNames(workflow)) {
      if (cachedJobs.has(name)) continue;
      const job = workflowJob(workflow, name);
      expect(job).not.toContain('TURBO_TOKEN:');
      expect(job).not.toContain('TURBO_TEAM:');
    }
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

import { describe, expect, it } from 'bun:test';

const repositoryRoot = new URL('../', import.meta.url);

async function readWorkflow(name: string): Promise<string> {
  return Bun.file(new URL(`.github/workflows/${name}`, repositoryRoot)).text();
}

describe('coverage workflow gates', () => {
  it('runs adjusted coverage for pull requests and merge groups without replacing ordinary tests', async () => {
    const workflow = await readWorkflow('ci.yaml');

    expect(workflow).toContain('pull_request:');
    expect(workflow).toContain('merge_group:');
    expect(workflow).toMatch(/\n  coverage:\n[\s\S]*?bun run test:coverage/);
    expect(workflow).toMatch(/\n  test:\n[\s\S]*?bun test --bail/);
  });

  it('blocks npm publication on adjusted coverage without adding coverage to prepack', async () => {
    const workflow = await readWorkflow('release.yaml');
    const runGates = await Bun.file(new URL('run-gates.ts', import.meta.url)).text();

    expect(workflow).toMatch(/\n  coverage:\n[\s\S]*?bun run test:coverage/);
    expect(workflow).toContain('needs: [verify, validate, coverage]');
    expect(runGates).not.toMatch(/prepack:[\s\S]*script: 'test:coverage'/);
  });
});

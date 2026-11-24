import { MemoryStorage } from "../embedded/storage/src/index.ts";
import { describe, expect, it } from 'bun:test';
import { checkWorkflowCompatibility } from '../core/contract/compatibility.ts';
import { Engine } from '../core/engine/index.ts';
import { WorkflowDocumentValidationError, type DocumentWorkflowHost } from './document.ts';
import { buildWorkflowDocumentManifest } from './manifest.ts';
import { registerWorkflowDocuments } from './register.ts';

let calls = 0;
const host: DocumentWorkflowHost = {
  activities: {
    greet: ({ input }) => {
      calls += 1;
      return input;
    },
    shout: ({ input }) => input,
  },
  triggerKinds: { manual: () => undefined },
};

function document(steps: readonly Record<string, unknown>[]): Record<string, unknown> {
  return { name: 'digest', trigger: { kind: 'manual' }, steps };
}

const greetHello = document([{ kind: 'activity', handler: 'greet', input: 'hello' }]);
const greetGoodbye = document([{ kind: 'activity', handler: 'greet', input: 'goodbye' }]);
const withShout = document([
  { kind: 'activity', handler: 'greet', input: 'hello' },
  { kind: 'activity', handler: 'shout', input: 'hello' },
]);

describe('buildWorkflowDocumentManifest', () => {
  it('builds the manifest registration installs, without calling a handler', async () => {
    const manifest = await buildWorkflowDocumentManifest(greetHello, host);
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    const [identity] = await registerWorkflowDocuments(engine, host, { active: [greetHello] });
    expect(manifest.name).toBe('digest');
    expect(manifest.revision).toBe(identity?.revision ?? '');
    expect(manifest.workflowVersion).toBe(identity?.workflowVersion ?? '');
    expect(calls).toBe(0);
  });

  it('reports a document compatible with itself and names the reasons for a changed one', async () => {
    const current = await buildWorkflowDocumentManifest(greetHello, host);
    expect(checkWorkflowCompatibility(current, current)).toEqual({ compatible: true });

    const inputEdit = await buildWorkflowDocumentManifest(greetGoodbye, host);
    expect(checkWorkflowCompatibility(current, inputEdit)).toEqual({
      compatible: false,
      reasons: ['workflow-version-incompatible', 'artifact-revision-mismatch'],
    });

    const newHandler = await buildWorkflowDocumentManifest(withShout, host);
    expect(checkWorkflowCompatibility(current, newHandler)).toEqual({
      compatible: false,
      reasons: [
        'contract-hash-mismatch',
        'workflow-version-incompatible',
        'artifact-revision-mismatch',
      ],
    });
  });

  it('refuses a document the host cannot run', async () => {
    let failure: unknown;
    try {
      await buildWorkflowDocumentManifest(
        document([{ kind: 'activity', handler: 'nobody', input: null }]),
        host,
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(WorkflowDocumentValidationError);
  });
});

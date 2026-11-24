/**
 * `.uses({...})`: a workflow declares the engine-provided activities it calls.
 * The declaration puts their schemas in `WorkflowContract.usedActivities`
 * (part of `revision`, not of `contractHash`), links each to the workflow in
 * the registry snapshot's `usedBy`, and leaves dispatch on the engine's
 * registered implementation.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from "../../embedded/storage/src/index.ts";
import { z } from 'zod';
import { buildWorkflowContract } from '../contract/build.ts';
import { contractHash } from '../contract/hash.ts';
import { parseWorkflowRevisionManifest } from '../contract/manifest-parse.ts';
import { buildWorkflowRevisionManifest } from '../contract/manifest.ts';
import { deriveWorkflowRevision } from '../contract/revision.ts';
import { buildRegistrySnapshot } from '../registry-snapshot.ts';
import { activity, workflow, WorkflowBuilderError, type WorkflowContext } from '../types.ts';
import { deriveWorkflowDefinitionRevision } from './definition-revision.ts';
import { Engine } from './index.ts';
import { buildRegistrationEntry } from './registration.ts';

const greetInput = z.object({ name: z.string() });
const greetOutput = z.string();

const greet = activity({
  name: 'greet',
  inputSchema: greetInput,
  outputSchema: greetOutput,
  execute: async ({ name }: { name: string }) => `hello ${name}`,
});

const audit = activity({ name: 'audit', execute: async () => 'audited' });

function welcomeBody() {
  return async function* (ctx: WorkflowContext) {
    return yield* ctx.run('greet', { name: 'Ada' });
  };
}

const welcome = workflow({ name: 'welcome', version: '1.0.0' })
  .uses({ greet })
  .execute(welcomeBody());

const welcomeUndeclared = workflow({ name: 'welcome', version: '1.0.0' }).execute(welcomeBody());

describe('workflow builder .uses()', () => {
  it('keeps only the name and schemas of each used activity', () => {
    expect(Object.keys(welcome.uses ?? {})).toEqual(['greet']);
    const used = welcome.uses?.['greet'];
    expect(used?.name).toBe('greet');
    expect(used?.inputSchema).toBe(greet.inputSchema);
    expect(used?.outputSchema).toBe(greet.outputSchema);
    expect(used).not.toHaveProperty('execute');
    expect(Object.isFrozen(welcome.uses)).toBe(true);
  });

  it('keeps an activity literally named __proto__ in .uses() and .activities()', () => {
    const proto = activity({ name: '__proto__', execute: async () => 'proto' });
    const scoped = workflow({ name: 'proto-scoped' })
      .activities({ ['__proto__']: proto })
      .execute(welcomeBody());
    const used = workflow({ name: 'proto-used' })
      .uses({ ['__proto__']: proto })
      .execute(welcomeBody());

    expect(Object.keys(scoped.activities)).toEqual(['__proto__']);
    expect(Object.keys(used.uses ?? {})).toEqual(['__proto__']);
    expect(Object.keys(buildWorkflowContract(used).usedActivities ?? {})).toEqual(['__proto__']);
  });

  it('omits uses from a workflow that declares none', () => {
    expect(welcomeUndeclared).not.toHaveProperty('uses');
  });

  it('rejects an entry whose key differs from the activity name', () => {
    expect(() => workflow({ name: 'w' }).uses({ salute: greet } as never)).toThrow(
      WorkflowBuilderError,
    );
  });

  it('rejects an entry that is not a named activity definition', () => {
    expect(() => workflow({ name: 'w' }).uses({ greet: async () => 'x' } as never)).toThrow(
      WorkflowBuilderError,
    );
  });

  it('rejects a second .uses() call', () => {
    const builder = workflow({ name: 'w' }).uses({ greet }) as unknown as {
      uses: (map: object) => unknown;
    };
    expect(() => builder.uses({ audit })).toThrow(WorkflowBuilderError);
  });

  it('rejects a name declared in both .activities() and .uses()', () => {
    // A type error too; the cast reaches the runtime check untyped callers hit.
    const builder = workflow({ name: 'w' })
      .activities({ greet })
      .uses({ greet } as never) as unknown as { execute: (body: unknown) => unknown };
    expect(() => builder.execute(welcomeBody())).toThrow(/both \.activities\(\) and \.uses\(\)/);
  });

  it('rejects a malformed uses map on an untrusted definition at registration', () => {
    const forged = { ...welcomeUndeclared, uses: { greet: { name: 'other' } } };
    expect(() => buildRegistrationEntry('welcome', forged)).toThrow(/must be an activity/);
  });

  it('rejects an untrusted uses value that is not a plain object', () => {
    const forged = { ...welcomeUndeclared, uses: new Map() };
    expect(() => buildRegistrationEntry('welcome', forged)).toThrow(/must be a plain object/);
  });

  it('rejects an untrusted uses entry that is also a scoped activity', () => {
    const scoped = workflow({ name: 'welcome' }).activities({ greet }).execute(welcomeBody());
    const forged = { ...scoped, uses: { greet: { name: 'greet' } } };
    expect(() => buildRegistrationEntry('welcome', forged)).toThrow(/both activities and uses/);
  });

  it('treats an empty untrusted uses map as no declaration', () => {
    const forged = { ...welcomeUndeclared, uses: {} };
    expect(buildRegistrationEntry('welcome', forged).uses).toBeUndefined();
  });

  it('rejects an untrusted uses entry whose schema is not a definition schema', () => {
    const forged = {
      ...welcomeUndeclared,
      uses: { greet: { name: 'greet', inputSchema: 'not a schema' } },
    };
    expect(() => buildRegistrationEntry('welcome', forged)).toThrow(/uses\.greet\.inputSchema/);
  });
});

describe('dispatching a used activity', () => {
  it('runs the engine-registered implementation', async () => {
    await using engine = await Engine.create({
      storage: new MemoryStorage(),
      activities: {
        greet: activity({
          name: 'greet',
          inputSchema: greetInput,
          outputSchema: greetOutput,
          execute: async () => 'from the engine',
        }),
      },
      workflows: { welcome },
    });
    const handle = await engine.start('welcome', null);
    expect(await handle.result()).toBe('from the engine');
  });
});

describe('the contract of a workflow that uses engine activities', () => {
  it('lists used activities with schemas under usedActivities, not activities', () => {
    const contract = buildWorkflowContract(welcome);
    expect(contract.activities).toBeUndefined();
    expect(Object.keys(contract.usedActivities ?? {})).toEqual(['greet']);
    expect(contract.usedActivities?.['greet']?.inputSchema).toMatchObject({ type: 'object' });
    expect(contract.usedActivities?.['greet']?.outputSchema).toMatchObject({ type: 'string' });
  });

  it('changes revision but not contractHash, so adopting .uses() is a compatible redeploy', async () => {
    const declared = buildWorkflowContract(welcome);
    const undeclared = buildWorkflowContract(welcomeUndeclared);

    expect(await contractHash(declared)).toBe(await contractHash(undeclared));
    expect(await deriveWorkflowRevision(declared)).not.toBe(
      await deriveWorkflowRevision(undeclared),
    );
  });

  it('survives a manifest parse round trip', async () => {
    const manifest = await buildWorkflowRevisionManifest(buildWorkflowContract(welcome));
    const parsed = await parseWorkflowRevisionManifest(JSON.parse(JSON.stringify(manifest)));
    if (!parsed.ok) throw new Error(`parse failed: ${parsed.message}`);
    expect(parsed.manifest.contract.usedActivities).toEqual(manifest.contract.usedActivities);
    expect(parsed.manifest.revision).toBe(manifest.revision);
  });

  it('rejects a manifest that declares one activity in both collections', async () => {
    const manifest = await buildWorkflowRevisionManifest(buildWorkflowContract(welcome));
    const hostile = JSON.parse(JSON.stringify(manifest)) as {
      contract: { activities?: Record<string, unknown> };
    };
    hostile.contract.activities = { greet: {} };
    const parsed = await parseWorkflowRevisionManifest(hostile);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('expected rejection');
    expect(parsed.message).toContain('both activities and usedActivities');
  });

  it('rejects a manifest whose usedActivities key is not a valid activity name', async () => {
    const manifest = await buildWorkflowRevisionManifest(buildWorkflowContract(welcome));
    const hostile = JSON.parse(JSON.stringify(manifest)) as {
      contract: { usedActivities: Record<string, unknown> };
    };
    hostile.contract.usedActivities = { 'not a name': {} };
    const parsed = await parseWorkflowRevisionManifest(hostile);
    expect(parsed.ok).toBe(false);
  });
});

describe('the registry snapshot', () => {
  it('links each engine activity to the workflows that use it, and builds the same contract', async () => {
    const report = workflow({ name: 'report' })
      .uses({ greet, audit })
      .execute(async function* (ctx: WorkflowContext) {
        return yield* ctx.run('audit');
      });
    await using engine = new Engine({ storage: new MemoryStorage() });
    engine.register(greet);
    engine.register(audit);
    engine.register(activity({ name: 'unused', execute: async () => 1 }));
    engine.register(welcome);
    engine.register(report);

    const snapshot = await buildRegistrySnapshot(engine);

    expect(snapshot.activities['greet']?.usedBy).toEqual(['report', 'welcome']);
    expect(snapshot.activities['audit']?.usedBy).toEqual(['report']);
    expect(snapshot.activities['unused']).not.toHaveProperty('usedBy');

    const manifest = snapshot.workflows.find((entry) => entry.name === 'welcome');
    expect(manifest?.contract).toEqual(buildWorkflowContract(welcome));
  });

  it('derives the same revision for a dynamic source as for the eager registration', async () => {
    await using engine = new Engine({ storage: new MemoryStorage() });
    engine.register(greet);
    engine.register(welcome);
    const snapshot = await buildRegistrySnapshot(engine);
    const eagerRevision = snapshot.workflows.find((entry) => entry.name === 'welcome')?.revision;

    expect(await deriveWorkflowDefinitionRevision(welcome)).toBe(eagerRevision!);
  });
});

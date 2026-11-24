import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { rejectionOf } from "../../../test-support/embedded/testing/src/helpers/promise-outcome.ts";
import { buildWorkflowContract } from '../contract/build.ts';
import { buildWorkflowManifestFromDefinition } from '../registry-workflow-manifest.ts';
import { workflowSource } from '../source/index.ts';
import type { WorkflowDefinition } from '../types.ts';
import { activity } from '../types/activity.ts';
import { query, signal, update } from '../types/message-handles.ts';
import { workflow } from '../types/workflow-function.ts';
import { copyWorkflowDefinition } from './construction.ts';
import { DynamicWorkflowSourceUnavailableError } from './dynamic-source-errors.ts';
import { Engine } from './index.ts';
import { buildPerWorkflowActivityRegistry, buildRegistrationEntry } from './registration.ts';
import { DefinitionSchemaRequiredError } from './schema-policy.ts';

const engines: Engine[] = [];
function track(engine: Engine): Engine {
  engines.push(engine);
  return engine;
}

afterEach(() => {
  for (const engine of engines.splice(0)) engine[Symbol.dispose]();
});

const payload = z.object({ id: z.string() });
const nothing = z.undefined();

function requiredEngine(): Engine {
  return track(new Engine({ schemas: 'required' }));
}

function schemaError(run: () => unknown): DefinitionSchemaRequiredError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DefinitionSchemaRequiredError);
    return error as DefinitionSchemaRequiredError;
  }
  throw new Error('expected DefinitionSchemaRequiredError');
}

const fullySchemaed = () => ({
  name: 'checkout' as const,
  inputSchema: payload,
  outputSchema: payload,
});

const finalizerWith = (schemas: { inputSchema?: z.ZodType; outputSchema?: z.ZodType }) =>
  activity({ name: 'teardown', execute: async () => undefined, ...schemas });

const schemalessWorkflow = workflow({ name: 'bare' })
  .activities({ charge: async () => 'ok' })
  .uses({ audit: activity({ name: 'audit', execute: async () => 'ok' }) })
  .signals({ approve: signal('approve') })
  .updates({ rename: update('rename') })
  .queries({ status: query('status') })
  .execute(async function* () {
    return 'done';
  });

// A dynamic source resolves only under the revision derived from its own
// manifest, so the source test registers `schemalessWorkflow` under that.
let schemalessRevision: string;

beforeAll(async () => {
  const definition = schemalessWorkflow as WorkflowDefinition;
  const entry = buildRegistrationEntry(definition.name, definition);
  const manifest = await buildWorkflowManifestFromDefinition(
    copyWorkflowDefinition(definition.name, entry),
    buildPerWorkflowActivityRegistry(schemalessWorkflow.activities).listDefinitions(),
  );
  schemalessRevision = manifest.revision;
});

describe('schemas engine option', () => {
  it('accepts schemaless definitions by default and under "optional"', async () => {
    for (const options of [undefined, { schemas: 'optional' as const }]) {
      const engine = track(new Engine(options));
      engine.register(schemalessWorkflow);
      engine.register(activity({ name: 'loose', execute: async () => 'ok' }));
      expect(engine.getWorkflowDefinition('bare')).toBeDefined();
    }
    const created = await Engine.create({
      activities: { loose: activity({ name: 'loose', execute: async () => 'ok' }) },
      workflows: { bare: schemalessWorkflow },
      recover: false,
    });
    track(created as unknown as Engine);
  });

  it('rejects a value other than "optional" or "required"', () => {
    expect(() => new Engine({ schemas: 'strict' as never })).toThrow(
      'options.schemas must be "optional" or "required" when provided',
    );
  });

  it('names every missing schema on a builder workflow', () => {
    const error = schemaError(() => requiredEngine().register(schemalessWorkflow));
    expect(error.definitionKind).toBe('workflow');
    expect(error.definitionName).toBe('bare');
    expect(error.missing).toEqual([
      'inputSchema',
      'outputSchema',
      'signals.approve.inputSchema',
      'updates.rename.inputSchema',
      'updates.rename.outputSchema',
      'queries.status.inputSchema',
      'queries.status.outputSchema',
      'activities.charge.inputSchema',
      'activities.charge.outputSchema',
      'uses.audit.inputSchema',
      'uses.audit.outputSchema',
    ]);
    expect(error.message).toContain('signals.approve.inputSchema');
  });

  it.each([
    ['inputSchema', { name: 'checkout', outputSchema: payload }],
    ['outputSchema', { name: 'checkout', inputSchema: payload }],
  ] as const)('rejects a workflow missing only its %s', (missing, options) => {
    const definition = workflow(options).execute(async function* () {
      return { id: 'x' };
    });
    expect(schemaError(() => requiredEngine().register(definition)).missing).toEqual([missing]);
  });

  it.each([
    ['finalizer.inputSchema', { outputSchema: nothing }],
    ['finalizer.outputSchema', { inputSchema: payload }],
  ] as const)('rejects a workflow whose finalizer lacks %s', (missing, schemas) => {
    const definition = workflow({ ...fullySchemaed(), finalizer: finalizerWith(schemas) }).execute(
      async function* () {
        return { id: 'x' };
      },
    );
    expect(schemaError(() => requiredEngine().register(definition)).missing).toEqual([missing]);
  });

  it('rejects each message and activity schema individually', () => {
    const cases = [
      [
        'signals.approve.inputSchema',
        workflow(fullySchemaed()).signals({ approve: signal('approve') }),
      ],
      [
        'updates.rename.inputSchema',
        workflow(fullySchemaed()).updates({
          rename: { name: 'rename', outputSchema: payload },
        }),
      ],
      [
        'updates.rename.outputSchema',
        workflow(fullySchemaed()).updates({
          rename: update('rename', { inputSchema: payload }),
        }),
      ],
      [
        'queries.status.inputSchema',
        workflow(fullySchemaed()).queries({ status: { name: 'status', outputSchema: payload } }),
      ],
      [
        'queries.status.outputSchema',
        workflow(fullySchemaed()).queries({
          status: query('status', { inputSchema: nothing }),
        }),
      ],
      [
        'activities.charge.inputSchema',
        workflow(fullySchemaed()).activities({
          charge: activity({ name: 'charge', execute: async () => 'ok', outputSchema: z.string() }),
        }),
      ],
      [
        'activities.charge.outputSchema',
        workflow(fullySchemaed()).activities({
          charge: activity({
            name: 'charge',
            execute: async (input: { id: string }) => input.id,
            inputSchema: payload,
          }),
        }),
      ],
    ] as const;
    for (const [missing, builder] of cases) {
      const definition = (builder as ReturnType<typeof workflow>).execute(async function* () {
        return { id: 'x' };
      });
      expect(schemaError(() => requiredEngine().register(definition as never)).missing).toEqual([
        missing,
      ]);
    }
  });

  it('lists missing message schemas in runtime-name order', () => {
    const definition = workflow(fullySchemaed())
      .signals({ zeta: signal('zeta'), alpha: signal('alpha') })
      .execute(async function* () {
        return { id: 'x' };
      });
    expect(schemaError(() => requiredEngine().register(definition)).missing).toEqual([
      'signals.alpha.inputSchema',
      'signals.zeta.inputSchema',
    ]);
  });

  it('leaves no state behind on rejection, and accepts the corrected definition', () => {
    const engine = requiredEngine();
    schemaError(() => engine.register(schemalessWorkflow));
    expect(engine.getWorkflowDefinition('bare')).toBeUndefined();

    const corrected = workflow({ name: 'bare', inputSchema: nothing, outputSchema: z.string() })
      .activities({
        charge: activity({
          name: 'charge',
          execute: async () => 'ok',
          inputSchema: nothing,
          outputSchema: z.string(),
        }),
      })
      .signals({ approve: signal('approve', { inputSchema: nothing }) })
      .updates({ rename: update('rename', { inputSchema: payload, outputSchema: nothing }) })
      .queries({ status: query('status', { inputSchema: nothing, outputSchema: z.string() }) })
      .execute(async function* () {
        return 'done';
      });
    engine.register(corrected);
    expect(engine.getWorkflowDefinition('bare')?.inputSchema).toBe(nothing);
  });

  it('accepts z.undefined() for a payload-less message, and its contract builds', () => {
    const definition = workflow({
      ...fullySchemaed(),
      finalizer: finalizerWith({ inputSchema: payload, outputSchema: nothing }),
    })
      .signals({ cancel: signal('cancel', { inputSchema: nothing }) })
      .execute(async function* () {
        return { id: 'x' };
      });
    requiredEngine().register(definition);
    const contract = buildWorkflowContract(definition);
    expect(contract.signals?.['cancel']).toBeDefined();
    expect(contract.finalizer).toBeDefined();
  });

  it('rejects a hand-rolled workflow definition without schemas', () => {
    const error = schemaError(() =>
      requiredEngine().register({ name: 'literal', handler: async function* () {} } as never),
    );
    expect(error.missing).toEqual(['inputSchema', 'outputSchema']);
  });

  it('rejects an engine-level activity passed to register()', () => {
    const engine = requiredEngine();
    const error = schemaError(() =>
      engine.register(activity({ name: 'loose', execute: async () => 'ok', inputSchema: nothing })),
    );
    expect(error.definitionKind).toBe('activity');
    expect(error.definitionName).toBe('loose');
    expect(error.missing).toEqual(['outputSchema']);
    engine.register(
      activity({
        name: 'strict',
        execute: async () => 'ok',
        inputSchema: nothing,
        outputSchema: z.string(),
      }),
    );
  });

  it('rejects an engine-level activity passed to Engine.create()', async () => {
    const error = await rejectionOf(
      Engine.create({
        schemas: 'required',
        activities: { loose: activity({ name: 'loose', execute: async () => 'ok' }) },
        recover: false,
      }),
    );
    expect(error).toBeInstanceOf(DefinitionSchemaRequiredError);
    expect((error as DefinitionSchemaRequiredError).missing).toEqual([
      'inputSchema',
      'outputSchema',
    ]);
  });

  it('rejects a workflow passed to Engine.create()', async () => {
    const error = await rejectionOf(
      Engine.create({
        schemas: 'required',
        workflows: { bare: schemalessWorkflow },
        recover: false,
      }),
    );
    expect(error).toBeInstanceOf(DefinitionSchemaRequiredError);
    expect((error as DefinitionSchemaRequiredError).definitionName).toBe('bare');
  });

  it('rejects a dynamic source whose loaded definition lacks schemas', async () => {
    const engine = requiredEngine();
    engine.registerSource(
      workflowSource(
        { name: 'bare', location: './bare.ts', exportName: 'bare', revision: schemalessRevision },
        async () => ({ bare: schemalessWorkflow }),
      ),
    );
    const error = await rejectionOf(engine.resolveWorkflowSource('bare', schemalessRevision));
    expect(error).toBeInstanceOf(DefinitionSchemaRequiredError);
    expect((error as DefinitionSchemaRequiredError).missing).toContain(
      'signals.approve.inputSchema',
    );
  });

  it('surfaces the rejection as the cause when engine.start() loads a schemaless source', async () => {
    const engine = requiredEngine();
    engine.registerSource(
      workflowSource(
        { name: 'bare', location: './bare.ts', exportName: 'bare', revision: schemalessRevision },
        async () => ({ bare: schemalessWorkflow }),
      ),
    );
    const error = await rejectionOf(engine.start('bare', undefined));
    expect(error).toBeInstanceOf(DynamicWorkflowSourceUnavailableError);
    expect((error as DynamicWorkflowSourceUnavailableError).cause).toBeInstanceOf(
      DefinitionSchemaRequiredError,
    );
  });
});

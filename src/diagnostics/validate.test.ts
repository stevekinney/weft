/**
 * Tests for the weft validate design-time linter.
 *
 * Covers the three anti-pattern checks:
 * - unbounded-retry: maxAttempts = Infinity
 * - stateful-without-compensator: non-idempotent activity with no compensate
 * - (formatting) formatValidationReport produces expected output
 */

import { describe, expect, it } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ActivityDefinition, WorkflowDefinition } from '../core/types.ts';
import { workflow } from '../core/types.ts';
import {
  formatValidationReport,
  loadRegistrationsFromModule,
  validateRegistrations,
} from './validate.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRegistration(name: string): WorkflowDefinition {
  return {
    name,
    handler: async function* () {
      return 'done';
    },
  };
}

function makeActivity(
  name: string,
  overrides: Partial<ActivityDefinition> = {},
): ActivityDefinition {
  return {
    name,
    execute: async (input: unknown) => input,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Clean registrations pass with no issues
// ---------------------------------------------------------------------------

describe('validateRegistrations', () => {
  it('returns valid=true and no issues for a clean registration with no activities', () => {
    const registrations = { myWorkflow: makeRegistration('myWorkflow') };
    const report = validateRegistrations(registrations);

    expect(report.valid).toBe(true);
    expect(report.issues).toHaveLength(0);
    expect(report.workflowCount).toBe(1);
  });

  it('returns valid=true for an idempotent activity without compensator', () => {
    const registrations = { wf: makeRegistration('wf') };
    const activities: ActivityDefinition[] = [makeActivity('readDb', { idempotent: true })];

    const report = validateRegistrations(registrations, activities);
    expect(report.valid).toBe(true);
    expect(report.issues).toHaveLength(0);
  });

  it('returns valid=true for a non-idempotent activity that has a compensator', () => {
    const registrations = { wf: makeRegistration('wf') };
    const activities: ActivityDefinition[] = [
      makeActivity('charge', {
        idempotent: false,
        compensate: async () => {},
      }),
    ];

    const report = validateRegistrations(registrations, activities);
    expect(report.valid).toBe(true);
    expect(report.issues).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // 2. Unbounded retry
  // ---------------------------------------------------------------------------

  it('reports error for activity with maxAttempts = Infinity', () => {
    const registrations = { wf: makeRegistration('wf') };
    const activities: ActivityDefinition[] = [
      // idempotent: true to suppress the stateful-without-compensator error,
      // so we can assert on exactly one issue (the unbounded-retry error).
      makeActivity('flaky', {
        idempotent: true,
        retry: {
          maxAttempts: Infinity,
          initialBackoff: '1s',
          backoffMultiplier: 2,
          maxBackoff: '30s',
        },
      }),
    ];

    const report = validateRegistrations(registrations, activities);
    expect(report.valid).toBe(false);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]!.code).toBe('unbounded-retry');
    expect(report.issues[0]!.severity).toBe('error');
    expect(report.issues[0]!.activityName).toBe('flaky');
  });

  it('does not flag activity with finite maxAttempts', () => {
    const registrations = { wf: makeRegistration('wf') };
    const activities: ActivityDefinition[] = [
      makeActivity('reliable', {
        retry: { maxAttempts: 5, initialBackoff: '1s', backoffMultiplier: 2, maxBackoff: '30s' },
        compensate: async () => {},
      }),
    ];

    const report = validateRegistrations(registrations, activities);
    const retryIssues = report.issues.filter((i) => i.code === 'unbounded-retry');
    expect(retryIssues).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // 3. Stateful without compensator
  // ---------------------------------------------------------------------------

  it('reports error for non-idempotent activity without compensator', () => {
    const registrations = { wf: makeRegistration('wf') };
    const activities: ActivityDefinition[] = [makeActivity('sendEmail', { idempotent: false })];

    const report = validateRegistrations(registrations, activities);
    expect(report.valid).toBe(false); // stateful-without-compensator is an error
    const issue = report.issues.find((i) => i.code === 'stateful-without-compensator');
    expect(issue).toBeDefined();
    expect(issue!.severity).toBe('error');
    expect(issue!.activityName).toBe('sendEmail');
  });

  it('stateful-without-compensator makes valid=false', () => {
    const registrations = { wf: makeRegistration('wf') };
    const activities: ActivityDefinition[] = [makeActivity('sideEffect', { idempotent: false })];

    const report = validateRegistrations(registrations, activities);
    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.severity === 'error')).toBe(true);
  });

  it('multiple issues accumulate across multiple activities', () => {
    const registrations = { wf: makeRegistration('wf') };
    const activities: ActivityDefinition[] = [
      makeActivity('a', {
        retry: {
          maxAttempts: Infinity,
          initialBackoff: '1s',
          backoffMultiplier: 2,
          maxBackoff: '30s',
        },
        compensate: async () => {},
      }),
      makeActivity('b', { idempotent: false }), // stateful-without-compensator error
      makeActivity('c', {
        retry: {
          maxAttempts: Infinity,
          initialBackoff: '1s',
          backoffMultiplier: 2,
          maxBackoff: '30s',
        },
        idempotent: false,
      }), // both unbounded-retry + stateful-without-compensator errors
    ];

    const report = validateRegistrations(registrations, activities);
    expect(report.valid).toBe(false);
    const errors = report.issues.filter((i) => i.severity === 'error');
    expect(errors.length).toBeGreaterThanOrEqual(3); // a=unbounded, b=stateful, c=both
  });

  it('empty registrations and no activities returns valid with 0 workflows', () => {
    const report = validateRegistrations({});
    expect(report.valid).toBe(true);
    expect(report.workflowCount).toBe(0);
    expect(report.issues).toHaveLength(0);
  });

  it('labels explicitly passed activities as standalone when no registrations are present', () => {
    const report = validateRegistrations({}, [makeActivity('sendEmail', { idempotent: false })]);

    expect(report.valid).toBe(false);
    expect(report.issues[0]?.workflowType).toBe('(standalone)');
  });

  it('validates activities embedded in builder-produced workflow definitions', () => {
    const definition = workflow({ name: 'checkout' })
      .activities({
        charge: makeActivity('charge', {
          idempotent: true,
          retry: {
            maxAttempts: Infinity,
            initialBackoff: '1s',
            backoffMultiplier: 2,
            maxBackoff: '30s',
          },
        }),
      })
      .execute(async function* () {
        return 'done';
      });

    const report = validateRegistrations({ checkout: definition });

    expect(report.valid).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: 'unbounded-retry',
        workflowType: 'checkout',
        activityName: 'charge',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// 4. formatValidationReport
// ---------------------------------------------------------------------------

describe('formatValidationReport', () => {
  it('shows no-issues message when report is clean', () => {
    const report = validateRegistrations({ wf: makeRegistration('wf') });
    const output = formatValidationReport(report, 'my-workflow.ts');

    expect(output).toContain('my-workflow.ts');
    expect(output).toContain('No issues found.');
  });

  it('includes issue code and severity in output', () => {
    const report = validateRegistrations({ wf: makeRegistration('wf') }, [
      makeActivity('pay', {
        idempotent: true,
        retry: {
          maxAttempts: Infinity,
          initialBackoff: '1s',
          backoffMultiplier: 2,
          maxBackoff: '30s',
        },
      }),
    ]);
    const output = formatValidationReport(report, 'entry.ts');

    expect(output).toContain('error');
    expect(output).toContain('unbounded-retry');
    expect(output).toContain('pay');
  });
});

// ---------------------------------------------------------------------------
// 5. loadRegistrationsFromModule
// ---------------------------------------------------------------------------

describe('loadRegistrationsFromModule', () => {
  it('picks up function-typed activity definitions (activity() helper shape)', async () => {
    // The activity() helper returns a function with `name` and `execute` as own
    // properties. isActivityDefinition must accept typeof === 'function'.
    const dir = await mkdtemp(join(tmpdir(), 'weft-validate-'));
    const filePath = join(dir, 'activities.ts');
    await writeFile(
      filePath,
      `
// Simulate the shape that activity() helper produces: a function with
// 'name' and 'execute' as own properties (not a plain object).
const def = { name: 'sendEmail', execute: async () => ({ sent: true }) };
const fn = Object.create(Function.prototype, {
  name: { value: def.name, writable: false, configurable: true },
  execute: { value: def.execute, writable: true, configurable: true },
});
export const sendEmail = fn;
`,
    );

    const { activities } = await loadRegistrationsFromModule(filePath);
    expect(activities.some((a) => a.name === 'sendEmail')).toBe(true);
    await expect(activities[0]!.execute('payload')).resolves.toEqual({ sent: true });
  });

  it('keys named workflow definitions by their canonical name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weft-validate-'));
    const filePath = join(dir, 'workflows.ts');
    await writeFile(
      filePath,
      `
export const greet = {
  name: 'canonical-greet',
  handler: async function* () { return 'hi'; }
};
`,
    );

    const { registrations } = await loadRegistrationsFromModule(filePath);
    expect('greet' in registrations).toBe(false);
    const iterator = registrations['canonical-greet']!.handler({} as never, undefined);
    await expect(iterator.next()).resolves.toEqual({ value: 'hi', done: true });
  });

  it('preserves workflow definitions whose canonical names are inherited object keys', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weft-validate-'));
    const filePath = join(dir, 'prototype-names.ts');
    await writeFile(
      filePath,
      `
export const protoWorkflow = {
  name: '__proto__',
  handler: async function* () { return 'proto'; }
};
export const stringWorkflow = {
  name: 'toString',
  handler: async function* () { return 'string'; }
};
`,
    );

    const { registrations } = await loadRegistrationsFromModule(filePath);

    expect(Object.getPrototypeOf(registrations)).toBeNull();
    expect(Object.keys(registrations).toSorted()).toEqual(['__proto__', 'toString']);
    expect(Object.hasOwn(registrations, '__proto__')).toBe(true);
    expect(Object.hasOwn(registrations, 'toString')).toBe(true);
    expect(registrations['__proto__']?.name).toBe('__proto__');
    expect(registrations['toString']?.name).toBe('toString');
  });

  it('uses own-property precedence when default and named exports share a prototype name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weft-validate-'));
    const filePath = join(dir, 'prototype-name-conflict.ts');
    await writeFile(
      filePath,
      `
const defaultDefinition = {
  name: 'toString',
  handler: async function* () { return 'default'; }
};
export const namedDefinition = {
  name: 'toString',
  handler: async function* () { return 'named'; }
};
export default { defaultDefinition };
`,
    );

    const { registrations } = await loadRegistrationsFromModule(filePath);
    const iterator = registrations['toString']!.handler({} as never, undefined);

    await expect(iterator.next()).resolves.toEqual({ value: 'default', done: true });
  });

  it('loads a single default-exported workflow definition', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weft-validate-'));
    const filePath = join(dir, 'default-definition.ts');
    await writeFile(
      filePath,
      `
export default {
  name: 'greet',
  handler: async function* () { return 'hi'; }
};
`,
    );

    const { registrations } = await loadRegistrationsFromModule(filePath);
    expect(Object.keys(registrations)).toEqual(['greet']);
  });

  it('loads registrations and activities from a default export object', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weft-validate-'));
    const filePath = join(dir, 'default-exports.ts');
    await writeFile(
      filePath,
      `
const registration = {
  name: 'greet',
  handler: async function* () { return 'hi'; }
};

const activity = Object.create(Function.prototype, {
  name: { value: 'sendEmail', writable: false, configurable: true },
  execute: { value: async () => ({ sent: true }), writable: true, configurable: true },
});

export default {
  greet: registration,
  sendEmail: activity,
};
`,
    );

    const result = await loadRegistrationsFromModule(filePath);
    expect(result.registrations['greet']).toBeDefined();
    expect(result.activities.some((activity) => activity.name === 'sendEmail')).toBe(true);
    const iterator = result.registrations['greet']!.handler({} as never, undefined);
    await expect(iterator.next()).resolves.toEqual({ value: 'hi', done: true });
    await expect(result.activities[0]!.execute('payload')).resolves.toEqual({ sent: true });
  });

  it('loads an activity named handler from a default export object', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weft-validate-'));
    const filePath = join(dir, 'handler-activity.ts');
    await writeFile(
      filePath,
      `
async function handler() {}
Object.defineProperty(handler, 'execute', {
  value: async () => ({ handled: true }),
  writable: true,
  configurable: true,
});

export default { handler };
`,
    );

    const result = await loadRegistrationsFromModule(filePath);

    expect(result.activities.map((activity) => activity.name)).toEqual(['handler']);
    await expect(result.activities[0]!.execute('payload')).resolves.toEqual({ handled: true });
  });

  it('keeps default-export definitions when a named export uses the same canonical name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weft-validate-'));
    const filePath = join(dir, 'conflict.ts');
    await writeFile(
      filePath,
      `
const defaultGreet = { name: 'greet', handler: async function* () { return 'default'; } };
export const greet = { name: 'greet', handler: async function* () { return 'named'; } };
export default { greet: defaultGreet };
`,
    );

    const { registrations } = await loadRegistrationsFromModule(filePath);
    const iterator = registrations['greet']!.handler({} as never, undefined);
    await expect(iterator.next()).resolves.toEqual({ value: 'default', done: true });
  });

  it('rejects the removed bare handler registration shape', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weft-validate-'));
    const filePath = join(dir, 'bare-handler.ts');
    await writeFile(
      filePath,
      `
export const greet = {
  handler: async function* () { return 'hi'; }
};
`,
    );

    await expect(loadRegistrationsFromModule(filePath)).rejects.toThrow(
      'Workflow export "greet" must be a builder-produced workflow definition with its own name',
    );
  });

  it('rejects removed registrations whose handler wraps an async generator', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weft-validate-'));
    const filePath = join(dir, 'wrapped-handler.ts');
    await writeFile(
      filePath,
      `
async function* greetWorkflow() { return 'hi'; }
export const greet = {
  handler: () => greetWorkflow()
};
`,
    );

    await expect(loadRegistrationsFromModule(filePath)).rejects.toThrow(
      'Workflow export "greet" must be a builder-produced workflow definition with its own name. Create it with `workflow({ name }).execute(handler)`.',
    );
  });

  it('ignores primitive exports that are neither registrations nor activity definitions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weft-validate-'));
    const filePath = join(dir, 'mixed-exports.ts');
    await writeFile(
      filePath,
      `
export const greeting = 'hello';
export default {
  count: 3,
};
`,
    );

    const result = await loadRegistrationsFromModule(filePath);
    expect(result.registrations).toEqual({});
    expect(result.activities).toEqual([]);
  });

  it('ignores circular non-definition object exports', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weft-validate-'));
    const filePath = join(dir, 'circular-export.ts');
    await writeFile(
      filePath,
      `
export const greet = {
  name: 'greet',
  handler: async function* () { return 'hi'; }
};

export const metadata = {};
metadata.self = metadata;
`,
    );

    const result = await loadRegistrationsFromModule(filePath);
    expect(Object.keys(result.registrations)).toEqual(['greet']);
  });

  it('ignores unrelated exported handler maps', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weft-validate-'));
    const filePath = join(dir, 'route-config.ts');
    await writeFile(
      filePath,
      `
export const greet = {
  name: 'greet',
  handler: async function* () { return 'hi'; }
};

export const routes = {
  webhook: { handler: async () => new Response('ok') },
};
`,
    );

    const result = await loadRegistrationsFromModule(filePath);
    expect(Object.keys(result.registrations)).toEqual(['greet']);
  });

  it('ignores unrelated handler objects beside workflows in a default export map', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'weft-validate-'));
    const filePath = join(dir, 'mixed-default-map.ts');
    await writeFile(
      filePath,
      `
const greet = {
  name: 'greet',
  handler: async function* () { return 'hi'; }
};

const route = { handler: async () => new Response('ok') };
export default { greet, route };
`,
    );

    const result = await loadRegistrationsFromModule(filePath);
    expect(Object.keys(result.registrations)).toEqual(['greet']);
  });
});

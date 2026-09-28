import { describe, expect, it } from 'bun:test';

import { workflow } from '../core/types.ts';
import { defineWorker, implementWorkflow, remoteActivity } from './authoring.ts';
import { buildQualifiedActivityTable } from './workflow-activity-binding.ts';

const formatGreeting = remoteActivity<{ name: string }, string, 'formatGreeting'>({
  name: 'formatGreeting',
  queue: 'greetings',
});

const welcome = workflow({ name: 'welcome' })
  .activities({
    formatGreeting: async (input: { name: string }) => `Hello, ${input.name}`,
    loadCount: async () => 1,
  })
  .execute(async function* (ctx, input: { name: string }) {
    const greeting = yield* ctx.run('formatGreeting', input);
    const count = yield* ctx.run('loadCount');
    return { greeting, count };
  });

describe('worker authoring primitives', () => {
  it('builds a worker definition from typed workflow implementations', async () => {
    const implementation = implementWorkflow(welcome, {
      activities: {
        formatGreeting: async (input) => `Hi, ${input.name}`,
        loadCount: async () => 7,
      },
    });

    const worker = defineWorker({
      deployment: 'greetings',
      workflows: { welcome: implementation },
    });

    expect(worker.workflows.welcome.name).toBe('welcome');
    const table = buildQualifiedActivityTable(worker.workflows);
    await expect(table['welcome.formatGreeting']?.({ name: 'Ada' })).resolves.toBe('Hi, Ada');
    await expect(table['welcome.loadCount']?.(undefined)).resolves.toBe(7);
  });

  it('declares remote activities without an execute fallback', () => {
    expect(formatGreeting.remote).toBe(true);
    expect('execute' in formatGreeting).toBe(false);
  });
});

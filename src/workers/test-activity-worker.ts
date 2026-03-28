/* eslint-disable unicorn/prefer-add-event-listener, unicorn/require-post-message-target-origin */
/// <reference lib="webworker" />

/**
 * Test activity worker for use in tests. Registers a set of simple activities
 * and wires up the activity worker message loop.
 */

import { initializeActivityWorkerMessageLoop } from './activity-worker-entry.ts';

const activities = new Map<string, (...arguments_: unknown[]) => unknown>();

activities.set('greet', (input: unknown) => `hello ${String(input)}`);
activities.set('double', (input: unknown) => (input as number) * 2);
activities.set('asyncDouble', async (input: unknown) => {
  await new Promise((resolve) => setTimeout(resolve, 1));
  return (input as number) * 2;
});
activities.set('failingActivity', () => {
  throw new Error('activity-failure');
});
activities.set('slowActivity', async (input: unknown) => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  return `slow:${String(input)}`;
});

initializeActivityWorkerMessageLoop((name) => activities.get(name));

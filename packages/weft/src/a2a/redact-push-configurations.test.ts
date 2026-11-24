import { describe, expect, it } from 'bun:test';

import type { AgentCard } from '@a2a-js/sdk';
import { DefaultRequestHandler } from '@a2a-js/sdk/server';

import {
  a2aStoreBackends,
  callContext,
  pushConfigFixture,
  taskFixture,
  useBackendStorage,
} from './a2a-store.test-support.ts';
import { agentCardFixture, echoExecutor } from './a2a.test-support.ts';
import { createWeftPushNotificationStore } from './push-notification-store.ts';
import {
  REDACTED_PUSH_CREDENTIALS,
  withRedactedPushConfigurations,
} from './redact-push-configurations.ts';
import { createWeftA2ATaskStore } from './task-store.ts';

const ALICE = callContext({ user: 'alice' });

function pushCapableCard(): AgentCard {
  const card = agentCardFixture();
  return { ...card, capabilities: { streaming: true, pushNotifications: true, extensions: [] } };
}

for (const backend of a2aStoreBackends) {
  describe(`withRedactedPushConfigurations [${backend.name}]`, () => {
    const openStorage = useBackendStorage(backend);

    it('redacts credentials in GetTaskPushNotificationConfig and ListTaskPushNotificationConfigs responses', async () => {
      const storage = openStorage();
      const taskStore = createWeftA2ATaskStore({ storage, namespace: 'agent' });
      const pushStore = createWeftPushNotificationStore({ storage, namespace: 'agent' });
      const requestHandler = new DefaultRequestHandler(
        pushCapableCard(),
        taskStore,
        echoExecutor,
        undefined,
        pushStore,
        { send: async () => undefined },
      );
      const served = withRedactedPushConfigurations(requestHandler);
      await taskStore.save(taskFixture('task-1'), ALICE);
      const created = await served.createTaskPushNotificationConfig(
        pushConfigFixture('task-1', { id: 'hook' }),
        ALICE,
      );
      const plain = await served.createTaskPushNotificationConfig(
        pushConfigFixture('task-1', {
          id: 'plain',
          url: 'https://plain.example.com',
          authentication: undefined,
        }),
        ALICE,
      );
      expect(created.id).toBe('hook');

      const fetched = await served.getTaskPushNotificationConfig(
        { tenant: '', taskId: 'task-1', id: 'hook' },
        ALICE,
      );
      expect(fetched.authentication).toEqual({
        scheme: 'Bearer',
        credentials: REDACTED_PUSH_CREDENTIALS,
      });
      expect(fetched.url).toBe('https://hooks.example.com/a2a');

      const listed = await served.listTaskPushNotificationConfigs(
        { tenant: '', taskId: 'task-1', pageSize: 0, pageToken: '' },
        ALICE,
      );
      expect(listed.configs.map((config) => config.authentication)).toEqual([
        { scheme: 'Bearer', credentials: REDACTED_PUSH_CREDENTIALS },
        undefined,
      ]);
      expect(listed.configs[1]).toEqual(plain);

      // The store keeps credentials for the sender, and the wrapper passes everything else through.
      expect(await pushStore.get('task-1', 'hook', ALICE)).toMatchObject({
        authentication: { credentials: 'secret-credential' },
      });
      expect(await served.getAgentCard()).toMatchObject({ name: 'Echo Agent' });
      expect(await served.getTask({ tenant: '', id: 'task-1' }, ALICE)).toMatchObject({
        id: 'task-1',
      });
    });
  });
}

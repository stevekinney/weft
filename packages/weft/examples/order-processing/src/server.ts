import { BunSQLiteStorage, Engine, serve } from '@lostgradient/weft';
import { resolveExampleEnvironment } from '../../environment-configuration.ts';

import { createOrderProcessingEngine, orderProcessingSchedule } from './registry';

const environment = resolveExampleEnvironment();
const port = environment.port;
const hostname = environment.host ?? '127.0.0.1';
const databasePath = environment.weftDatabasePath ?? './order-processing.sqlite';

if (import.meta.main) {
  using storage = new BunSQLiteStorage(databasePath);
  await using engine = createOrderProcessingEngine(new Engine({ storage }));
  await engine.recoverAll({ acknowledgeUnknownWorkflowTypes: true });
  try {
    await engine.schedule(orderProcessingSchedule);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('already exists')) {
      throw error;
    }
  }

  await using server = serve({
    engine,
    hostname,
    port,
    publicOrigin: `http://localhost:${port}`,
  });

  process.stdout.write(`Order processing example listening at ${server.url}\n`);

  await new Promise(() => {});
}

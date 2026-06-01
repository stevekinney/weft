import { Engine } from '@lostgradient/weft';
import { serve } from '@lostgradient/weft/server';
import { SQLiteStorage } from '@lostgradient/weft/storage/sqlite';

import { createOrderProcessingEngine, orderProcessingSchedule } from './registry';

const port = Number(Bun.env['PORT'] ?? 7321);
const hostname = Bun.env['HOST'] ?? '127.0.0.1';
const databasePath = Bun.env['WEFT_DATABASE_PATH'] ?? './order-processing.sqlite';

async function loadDashboard(): Promise<unknown> {
  try {
    const dashboardModule = await import('../../../src/dashboard/index.html' as string);
    return dashboardModule.default;
  } catch {
    return null;
  }
}

if (import.meta.main) {
  using storage = new SQLiteStorage(databasePath);
  await using engine = createOrderProcessingEngine(new Engine({ storage }));
  await engine.recoverAll({ acknowledgeUnknownWorkflowTypes: true });
  try {
    await engine.schedule(orderProcessingSchedule);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('already exists')) {
      throw error;
    }
  }
  const dashboard = await loadDashboard();

  await using server = serve({
    dashboard,
    engine,
    hostname,
    port,
    publicOrigin: `http://localhost:${port}`,
  });

  console.log(`Order processing example listening at ${server.url}`);
  if (dashboard !== null) {
    console.log(`Dashboard: ${server.url}`);
  }

  await new Promise(() => {});
}

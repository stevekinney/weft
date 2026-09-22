import { environmentalist } from '@lostgradient/environmentalist';
import { z } from 'zod';

const schema = z.object({
  workerUrl: z.string().optional().meta({ env: 'WEFT_WORKER_URL' }),
  protocolVersion: z
    .string()
    .optional()
    .transform((value) => Number(value ?? '6'))
    .meta({ env: 'WEFT_WORKER_PROTOCOL_VERSION' }),
  activities: z
    .string()
    .optional()
    .transform((value) =>
      (value ?? '')
        .split(',')
        .map((activity) => activity.trim())
        .filter((activity) => activity.length > 0),
    )
    .meta({ env: 'WEFT_WORKER_ACTIVITIES' }),
  heartbeatIntervalMs: z
    .string()
    .optional()
    .transform((value) => Number(value ?? '10000'))
    .meta({ env: 'WEFT_CONFORMANCE_HEARTBEAT_INTERVAL_MS' }),
  shortSleepExitMode: z
    .string()
    .optional()
    .transform((value) => value ?? 'default')
    .meta({ env: 'WEFT_SHORT_SLEEP_EXIT_MODE' }),
  shortSleepExitStateFile: z.string().optional().meta({ env: 'WEFT_SHORT_SLEEP_EXIT_STATE_FILE' }),
  lostAckStateFile: z.string().optional().meta({ env: 'WEFT_LOST_ACK_STATE_FILE' }),
});

/** Resolve the subprocess conformance protocol's existing defaults and conversions. */
export function resolveFixtureEnvironment() {
  const env: Record<string, string> = {};
  for (const name of [
    'WEFT_WORKER_URL',
    'WEFT_WORKER_PROTOCOL_VERSION',
    'WEFT_WORKER_ACTIVITIES',
    'WEFT_CONFORMANCE_HEARTBEAT_INTERVAL_MS',
    'WEFT_SHORT_SLEEP_EXIT_MODE',
    'WEFT_SHORT_SLEEP_EXIT_STATE_FILE',
    'WEFT_LOST_ACK_STATE_FILE',
  ]) {
    const value = Bun.env[name];
    if (value !== undefined) env[name] = value;
  }
  return environmentalist.sync({
    name: 'weft-conformance-fixture',
    schema,
    env,
    argv: [],
    coerce: false,
    sources: ['env', 'defaults'],
  });
}

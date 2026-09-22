import { environmentalist } from '@lostgradient/environmentalist';
import { z } from 'zod';

const schema = z.object({
  weftCheckoutDatabasePath: z.string().optional().meta({ env: 'WEFT_CHECKOUT_DATABASE_PATH' }),
  weftDatabasePath: z.string().optional().meta({ env: 'WEFT_DATABASE_PATH' }),
  port: z
    .string()
    .optional()
    .transform((value) => Number(value ?? 7321))
    .meta({ env: 'PORT' }),
  host: z.string().optional().meta({ env: 'HOST' }),
});

/** Resolve only the runnable examples' environment values. */
export function resolveExampleEnvironment() {
  const env: Record<string, string> = {};
  for (const name of ['WEFT_CHECKOUT_DATABASE_PATH', 'WEFT_DATABASE_PATH', 'PORT', 'HOST']) {
    const value = Bun.env[name];
    if (value !== undefined) env[name] = value;
  }
  return environmentalist.sync({
    name: 'weft-examples',
    schema,
    env,
    sources: ['env', 'defaults'],
    argv: [],
    coerce: false,
  });
}

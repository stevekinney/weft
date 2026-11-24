import { environmentalist } from '@lostgradient/environmentalist';
import type { Source } from '@lostgradient/environmentalist/types';
import { z } from 'zod';

const schema = z.object({
  keepDurabilityFixtures: z
    .string()
    .optional()
    .transform((value) => value === '1')
    .meta({ env: 'WEFT_KEEP_DURABILITY_FIXTURES' }),
});

function loadEnvironment() {
  const environment = typeof process !== 'undefined' ? process.env : {};
  const mapping = {
    keepDurabilityFixtures: 'WEFT_KEEP_DURABILITY_FIXTURES',
  };
  const values: Record<string, string> = {};
  for (const [key, name] of Object.entries(mapping)) {
    const value = environment[name];
    if (value !== undefined) values[key] = value;
  }
  return { values, location: 'runtime environment' };
}

const source: Source = {
  id: 'storage-environment',
  kind: 'string',
  load: loadEnvironment,
  loadSync: loadEnvironment,
};

/**
 * Resolve the storage package's settings from the environment without requiring a server runtime.
 *
 * @returns the resolved settings, with `keepDurabilityFixtures` true when
 *   `WEFT_KEEP_DURABILITY_FIXTURES=1`
 */
export function resolveStorageEnvironment() {
  return environmentalist.sync({
    name: 'storage',
    schema,
    sources: [source, 'defaults'],
    argv: [],
    coerce: false,
  });
}

import { environmentalist } from '@lostgradient/environmentalist';
import type { Source } from '@lostgradient/environmentalist/types';
import { z } from 'zod';

const schema = z.object({
  weftDefaultStoragePath: z.string().optional().meta({ env: 'WEFT_DEFAULT_STORAGE_PATH' }),
  keepDurabilityFixtures: z
    .string()
    .optional()
    .transform((value) => value === '1')
    .meta({ env: 'WEFT_KEEP_DURABILITY_FIXTURES' }),
});

function loadEnvironment() {
  const environment =
    typeof Bun !== 'undefined' ? Bun.env : typeof process !== 'undefined' ? process.env : {};
  const mapping = {
    weftDefaultStoragePath: 'WEFT_DEFAULT_STORAGE_PATH',
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
  id: 'weft-storage-environment',
  kind: 'string',
  load: loadEnvironment,
  loadSync: loadEnvironment,
};

/** Resolve storage settings without requiring a server runtime. */
export function resolveStorageEnvironment() {
  return environmentalist.sync({
    name: 'weft-storage',
    schema,
    sources: [source, 'defaults'],
    argv: [],
    coerce: false,
  });
}

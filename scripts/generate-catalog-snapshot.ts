#!/usr/bin/env bun

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { format, resolveConfig } from 'prettier';

import {
  createCatalogSnapshot,
  stringifyCatalogSnapshot,
} from '../src/cli/operation-catalog-snapshot.ts';

export const CATALOG_SNAPSHOT_PATH = 'src/cli/generated/operation-catalog.snapshot.json';

async function main(): Promise<void> {
  const prettierOptions = (await resolveConfig(CATALOG_SNAPSHOT_PATH)) ?? {};
  const output = await format(stringifyCatalogSnapshot(createCatalogSnapshot()), {
    ...prettierOptions,
    filepath: CATALOG_SNAPSHOT_PATH,
  });
  await mkdir(dirname(CATALOG_SNAPSHOT_PATH), { recursive: true });
  await Bun.write(CATALOG_SNAPSHOT_PATH, output);
  console.log(`catalog snapshot: wrote ${CATALOG_SNAPSHOT_PATH}`);
}

if (import.meta.main) {
  await main();
}

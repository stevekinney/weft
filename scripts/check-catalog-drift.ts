#!/usr/bin/env bun

import { format, resolveConfig } from 'prettier';

import {
  createCatalogSnapshot,
  stringifyCatalogSnapshot,
} from '../src/cli/operation-catalog-snapshot.ts';
import { createOperationClientSource } from './generate-operation-client.ts';

const CATALOG_SNAPSHOT_PATH = 'src/cli/generated/operation-catalog.snapshot.json';
const OPERATION_CLIENT_PATH = 'src/cli/generated/operation-client.generated.ts';

const snapshot = createCatalogSnapshot();
const snapshotPrettierConfiguration = await resolveConfig(CATALOG_SNAPSHOT_PATH);
const expected = await format(
  stringifyCatalogSnapshot(snapshot),
  snapshotPrettierConfiguration === null
    ? { filepath: CATALOG_SNAPSHOT_PATH }
    : { ...snapshotPrettierConfiguration, filepath: CATALOG_SNAPSHOT_PATH },
);
const currentFile = Bun.file(CATALOG_SNAPSHOT_PATH);
const current = (await currentFile.exists()) ? await currentFile.text() : '';

if (current !== expected) {
  console.error(
    `catalog snapshot drift detected. Run: bun run scripts/generate-catalog-snapshot.ts`,
  );
  process.exit(1);
}

console.log(`catalog snapshot: ${CATALOG_SNAPSHOT_PATH} is up to date`);

const expectedClient = await createOperationClientSource(snapshot);
const generatedClient = Bun.file(OPERATION_CLIENT_PATH);
const currentClient = (await generatedClient.exists()) ? await generatedClient.text() : '';
if (currentClient !== expectedClient) {
  console.error(
    `catalog operation client drift detected. Run: bun run scripts/generate-operation-client.ts`,
  );
  process.exit(1);
}

console.log(`catalog operation client: ${OPERATION_CLIENT_PATH} is up to date`);

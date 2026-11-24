#!/usr/bin/env bun

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import packageJson from '../package.json' with { type: 'json' };

import { format, resolveConfig } from 'prettier';

import type { CatalogSnapshot } from "../src/embedded/backchannel/src/index.ts";
import {
  createOperationClientSources as createCatalogOperationClientSources,
  type OperationClientOptions,
} from "../src/embedded/backchannel/src/generator.ts";
import { createCatalogSnapshot } from '../src/server/weft-catalog-snapshot.ts';

import { weftOperationDomainName } from './operation-client-domains.ts';

/**
 * The name the generated examples import from — read from the manifest rather than written
 * here, because this generator is published alongside the package it describes and a mirror of
 * it carries a different name. A hardcoded name would make the generated file drift the moment
 * the package was renamed, and the drift test would report the generator as wrong.
 */
const packageName: string = packageJson.name;

export const OPERATION_CLIENT_DIRECTORY = 'src/client/generated';
export const OPERATION_CLIENT_FILE = 'operation-client.generated.ts';

/**
 * Weft's values for the generic generator in `@lostgradient/backchannel/generator`: its names, its
 * `/v1` REST prefix, its four domain splits, the Storage tag its byte-oriented facade owns, and a
 * connection that resolves from the environment, a profile or a run lockfile.
 */
const operationClientOptions: OperationClientOptions = {
  packageName,
  serverName: 'Weft',
  factoryName: 'createWeftClient',
  outputDirectory: OPERATION_CLIENT_DIRECTORY,
  outputFile: OPERATION_CLIENT_FILE,
  restPathPrefix: '/v1',
  excludedRestTags: ['Storage'],
  // Weft serves its subscriptions through REST bindings on other paths, not the generic route.
  subscriptions: 'none',
  domainName: weftOperationDomainName,
  examples: {
    list: 'weft.alerts.list',
    callable: 'weft.activities.complete',
    cancel: 'weft.workflows.cancel',
    restOnly: 'weft.catalog.diagnostics',
  },
  connection: {
    typeName: 'WeftClientConnection',
    transportName: 'httpJsonRpcTransport',
    importSpecifier: '../weft-connection-transport.ts',
    defaultValue: '{}',
    description: [
      'Connection settings resolve in the usual',
      'order — explicit options, environment, named profile, then the default',
      'address — so passing nothing is right when the environment already describes',
      'the server. In library code pass `includeRunLockfile: false`, so a stray',
      'local `weft serve` lockfile cannot quietly redirect your calls.',
    ],
    example: "{\n  server: 'http://localhost:7233',\n  includeRunLockfile: false,\n}",
  },
  format: async (contents, filePath) => {
    const configuration = await resolveConfig(filePath);
    return format(contents, { ...configuration, filepath: filePath });
  },
};

export function createOperationClientSources(
  snapshot: CatalogSnapshot,
): Promise<ReadonlyMap<string, string>> {
  return createCatalogOperationClientSources(snapshot, operationClientOptions);
}

/**
 * The command behind `bun scripts/generate-operation-client.ts`: generates the client from the
 * live catalog and writes each file to `--output-directory` (the checked-in
 * {@link OPERATION_CLIENT_DIRECTORY} by default), reporting one `wrote <path>` line per file.
 *
 * Exported so tests run it in process. Spawning it would put a Bun boot, the catalog load, and a
 * cold prettier inside the per-test budget (COR-1459).
 */
export async function runGenerateOperationClientCommand(
  args: readonly string[],
  log: (line: string) => void = console.log,
): Promise<void> {
  const { values } = parseArgs({
    args: [...args],
    options: { 'output-directory': { type: 'string' } },
    strict: true,
  });
  const directory = values['output-directory'] ?? OPERATION_CLIENT_DIRECTORY;
  const sources = await createOperationClientSources(createCatalogSnapshot());
  await mkdir(directory, { recursive: true });
  for (const [fileName, source] of sources) {
    const path = join(directory, fileName);
    await Bun.write(path, source);
    log(`wrote ${path}`);
  }
}

if (import.meta.main) await runGenerateOperationClientCommand(Bun.argv.slice(2));

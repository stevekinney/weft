#!/usr/bin/env bun
/**
 * Enforce that non-test implementation files over the repository's preferred
 * line-count ceiling are explicitly classified.
 */

import { Glob, file } from 'bun';
import { join } from 'node:path';

export const IMPLEMENTATION_FILE_SIZE_LIMIT = 500;

export const IMPLEMENTATION_FILE_GLOBS = [
  'src/**/*.{ts,tsx,mts,cts,svelte}',
  'scripts/**/*.{ts,tsx,mts,cts,svelte}',
  'tests/**/*.{ts,tsx,mts,cts,svelte}',
] as const;

export type OversizedImplementationFileClassification = 'justified-exception' | 'tracked-elsewhere';

export type OversizedImplementationFile = {
  readonly path: string;
  readonly classification: OversizedImplementationFileClassification;
  readonly rationale: string;
};

export const CLASSIFIED_OVERSIZED_IMPLEMENTATION_FILES = [
  {
    path: 'scripts/validate-package-consumers.ts',
    classification: 'justified-exception',
    rationale:
      'The packed-consumer regression suite `bun run prepack` drives is deliberately one script ' +
      'so every "install the built tarball and exercise a real consumer scenario" check shares ' +
      'one pack/install/cleanup lifecycle; splitting it would scatter that lifecycle across files.',
  },
  {
    path: 'scripts/check-coverage.ts',
    classification: 'justified-exception',
    rationale:
      'Coverage allowances, LCOV parsing, and adjusted-total reporting stay together so the coverage gate has one auditable policy owner.',
  },
  {
    path: 'src/core/engine/index.ts',
    classification: 'tracked-elsewhere',
    rationale:
      'The Engine declaration surface is tracked by local task 3765ffa6-1430-4be5-970c-c0f984ff34df; this issue excludes that refactor.',
  },
  {
    path: 'src/core/engine/bulk-operations.ts',
    classification: 'justified-exception',
    rationale:
      'Bulk cancel, delete, retry, signal, tag, and purge operations share one confirmation, filtering, outcome, and audit contract.',
  },
  {
    path: 'src/storage/interface.ts',
    classification: 'justified-exception',
    rationale:
      'The storage interface is a public type and helper surface where splitting would scatter one import contract across multiple subpaths.',
  },
  {
    path: 'src/client/client-contract.test-support.ts',
    classification: 'justified-exception',
    rationale:
      'The shared client contract harness intentionally keeps cross-transport behavior assertions in one reusable test-support module.',
  },
  {
    path: 'src/core/engine/state-utilities.ts',
    classification: 'justified-exception',
    rationale:
      'Workflow state decoding, summaries, filters, and debug sanitization are coupled around the persisted workflow-state boundary.',
  },
  {
    path: 'scripts/snapshot-public-api.ts',
    classification: 'justified-exception',
    rationale:
      'Public API snapshotting keeps export traversal, declaration capture, and snapshot comparison together as one release-surface audit.',
  },
  {
    path: 'src/client/interface.ts',
    classification: 'justified-exception',
    rationale:
      'The public client interface keeps transport-uniform overloads, handles, schedules, reviews, and stream contracts in one type surface.',
  },
  {
    path: 'src/core/engine/termination/complete.ts',
    classification: 'justified-exception',
    rationale:
      'Terminal completion coordinates status transitions, timers, indexes, waiters, events, and cleanup from one status gate.',
  },
  {
    path: 'src/worker/index.ts',
    classification: 'justified-exception',
    rationale:
      'The worker entrypoint keeps registration, protocol negotiation, dispatch, completion, heartbeat, and shutdown behavior together.',
  },
  {
    path: 'src/server/operations/get-task-diagnostics.ts',
    classification: 'justified-exception',
    rationale:
      'Task diagnostics classify queued, inflight, resolved, and dead-letter records into one bounded operator response.',
  },
  {
    path: 'scripts/verify-tree-shaking.ts',
    classification: 'justified-exception',
    rationale:
      'Tree-shaking verification keeps build setup, bundle inspection, source-map checks, and package export assertions in one audit.',
  },
  {
    path: 'src/index.ts',
    classification: 'justified-exception',
    rationale:
      'The package root is the intentional public export manifest; splitting it would add indirection without reducing implementation complexity.',
  },
  {
    path: 'src/core/types/workflow-builder.ts',
    classification: 'justified-exception',
    rationale:
      'Workflow-builder types form one fluent type-state contract where splitting would obscure the compile-time state transitions.',
  },
  {
    path: 'src/server/task-state.ts',
    classification: 'justified-exception',
    rationale:
      'Task-state storage owns queued, inflight, resolved, dead-letter, and worker-index records under one persistence contract.',
  },
  {
    path: 'src/client/http-client.ts',
    classification: 'justified-exception',
    rationale:
      'The HTTP client class centralizes the transport implementation behind the public client interface without preserving old import paths.',
  },
  {
    path: 'src/workers/workflow-runner.ts',
    classification: 'justified-exception',
    rationale:
      'Worker-runner message handling, replay, context wiring, and result reporting stay together as the worker isolate boundary.',
  },
  {
    path: 'src/core/engine/checkpoint-io.ts',
    classification: 'justified-exception',
    rationale:
      'Checkpoint I/O owns decode, encode, chunk, archive, and retention behavior around one durable checkpoint boundary.',
  },
  {
    path: 'scripts/husky/run-tests.ts',
    classification: 'justified-exception',
    rationale:
      'The hook test runner keeps staged-file routing, load-sensitive exclusions, and diagnosable output in one local hook command.',
  },
  {
    path: 'src/core/context/index.ts',
    classification: 'justified-exception',
    rationale:
      'Workflow context exposes the generator-facing API surface; splitting it would make one context contract harder to inspect.',
  },
  {
    path: 'src/core/types/workflow-context.ts',
    classification: 'justified-exception',
    rationale:
      'Workflow-context types define one public generator API contract whose overloads and helper result types need local adjacency.',
  },
  {
    path: 'src/server/operations/bulk-filter-helpers.ts',
    classification: 'justified-exception',
    rationale:
      'Bulk filter helpers keep REST, JSON-RPC, preview, and commit parsing aligned for the shared bulk-operation contract.',
  },
  {
    path: 'src/server/index.ts',
    classification: 'justified-exception',
    rationale:
      'The server entrypoint owns the public serve surface and exported server types; further splitting would create shallow re-export files.',
  },
  {
    path: 'src/storage/indexeddb.ts',
    classification: 'justified-exception',
    rationale:
      'IndexedDB storage keeps browser schema setup, transactions, scans, batching, and capability reporting in one adapter boundary.',
  },
  {
    path: 'src/core/worker-protocol.ts',
    classification: 'justified-exception',
    rationale:
      'Worker protocol types and validators stay together so wire messages, limits, and validation errors remain one auditable contract.',
  },
  {
    path: 'src/mcp/tools.ts',
    classification: 'justified-exception',
    rationale:
      'MCP tool schemas and handlers are intentionally adjacent so tool metadata and operation dispatch cannot drift.',
  },
  {
    path: 'src/storage/web-extension.ts',
    classification: 'justified-exception',
    rationale:
      'WebExtension storage keeps namespace detection, callback/promise bridging, quota handling, and scans in one adapter boundary.',
  },
  {
    path: 'src/core/engine/operations-coordination.ts',
    classification: 'justified-exception',
    rationale:
      'Coordination operations keep race, all, nested signal, and branch-dispatch semantics together around one coordinator boundary.',
  },
  {
    path: 'src/core/engine/operations-activity.ts',
    classification: 'justified-exception',
    rationale:
      'Activity operations coordinate interceptors, retries, reconciliation, async completion, verification, and result feeding together.',
  },
  {
    path: 'src/core/engine/signals.ts',
    classification: 'justified-exception',
    rationale:
      'Signal buffering, waiter tracking, payload validation, and atomic consumption share one durable signal-delivery contract.',
  },
  {
    path: 'src/client/http-client-requests.ts',
    classification: 'justified-exception',
    rationale:
      'HTTP request helpers are grouped by one client transport and mostly sit just above the threshold; splitting would add routing noise.',
  },
  {
    path: 'scripts/generate-operation-client.ts',
    classification: 'justified-exception',
    rationale:
      'The operation-client generator keeps schema normalization, alias selection, rendering, formatting, and drift output together.',
  },
] as const satisfies readonly OversizedImplementationFile[];

type CliArguments = {
  readonly root: string;
  readonly showHelp: boolean;
};

type MeasuredImplementationFile = {
  readonly path: string;
  readonly lines: number;
};

function parseArguments(argv: readonly string[]): CliArguments {
  let root: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') {
      root = argv[index + 1] ?? null;
      index += 1;
    } else if (argument === '--help' || argument === '-h') {
      return { root: root ?? join(import.meta.dir, '..'), showHelp: true };
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return { root: root ?? join(import.meta.dir, '..'), showHelp: false };
}

function printUsage(): void {
  console.log(
    [
      'Usage: bun scripts/check-implementation-file-sizes.ts [--root <path>]',
      '',
      `Fails when a non-test implementation file has more than ${IMPLEMENTATION_FILE_SIZE_LIMIT} lines without a classification.`,
    ].join('\n'),
  );
}

function isExcludedPath(relativePath: string): boolean {
  return (
    relativePath.includes('/generated/') ||
    /\.(?:test|spec)(?:-d)?\.(?:ts|tsx|mts|cts|svelte)$/.test(relativePath)
  );
}

function countLines(source: string): number {
  if (source.length === 0) return 0;
  return source.endsWith('\n') ? source.split('\n').length - 1 : source.split('\n').length;
}

async function* iterateImplementationFiles(root: string): AsyncGenerator<string> {
  for (const pattern of IMPLEMENTATION_FILE_GLOBS) {
    const glob = new Glob(pattern);
    for await (const relativePath of glob.scan({ cwd: root })) {
      if (isExcludedPath(relativePath)) continue;
      yield relativePath;
    }
  }
}

async function measureOversizedFiles(root: string): Promise<MeasuredImplementationFile[]> {
  const measured: MeasuredImplementationFile[] = [];

  for await (const relativePath of iterateImplementationFiles(root)) {
    const source = await file(join(root, relativePath)).text();
    const lines = countLines(source);
    if (lines > IMPLEMENTATION_FILE_SIZE_LIMIT) {
      measured.push({ path: relativePath, lines });
    }
  }

  return measured.toSorted(
    (left, right) => right.lines - left.lines || left.path.localeCompare(right.path),
  );
}

async function measureExistingClassifiedFiles(root: string): Promise<MeasuredImplementationFile[]> {
  const measured: MeasuredImplementationFile[] = [];

  for (const classification of CLASSIFIED_OVERSIZED_IMPLEMENTATION_FILES) {
    const implementationFile = file(join(root, classification.path));
    if (!(await implementationFile.exists())) continue;
    measured.push({
      path: classification.path,
      lines: countLines(await implementationFile.text()),
    });
  }

  return measured.toSorted((left, right) => left.path.localeCompare(right.path));
}

export function assertUniqueClassifications(
  classifications: readonly OversizedImplementationFile[] = CLASSIFIED_OVERSIZED_IMPLEMENTATION_FILES,
): void {
  const seen = new Set<string>();
  for (const classification of classifications) {
    if (seen.has(classification.path)) {
      throw new Error(`Duplicate oversized-file classification for ${classification.path}`);
    }
    seen.add(classification.path);
  }
}

export async function runCli(argv: readonly string[]): Promise<number> {
  const { root, showHelp } = parseArguments(argv);
  if (showHelp) {
    printUsage();
    return 0;
  }
  assertUniqueClassifications();

  const classifications = new Map(
    CLASSIFIED_OVERSIZED_IMPLEMENTATION_FILES.map((entry) => [entry.path, entry]),
  );
  const oversizedFiles = await measureOversizedFiles(root);
  const existingClassifiedFiles = await measureExistingClassifiedFiles(root);

  const unclassified = oversizedFiles.filter((entry) => !classifications.has(entry.path));
  const staleClassifications = existingClassifiedFiles.filter(
    (entry) => entry.lines <= IMPLEMENTATION_FILE_SIZE_LIMIT,
  );

  if (unclassified.length > 0) {
    console.error(
      `Found ${unclassified.length} implementation file(s) over ${IMPLEMENTATION_FILE_SIZE_LIMIT} lines without a classification:`,
    );
    for (const entry of unclassified) {
      console.error(`  ${entry.lines.toString().padStart(5)} ${entry.path}`);
    }
  }

  if (staleClassifications.length > 0) {
    console.error(
      `Found ${staleClassifications.length} classified implementation file(s) at or below ${IMPLEMENTATION_FILE_SIZE_LIMIT} lines:`,
    );
    for (const entry of staleClassifications) {
      console.error(`  ${entry.lines.toString().padStart(5)} ${entry.path}`);
    }
    console.error(
      'Remove stale classifications from the executable registry and contributor documentation.',
    );
  }

  if (unclassified.length > 0 || staleClassifications.length > 0) {
    return 1;
  }

  console.log(
    `OK: ${oversizedFiles.length} implementation file(s) over ${IMPLEMENTATION_FILE_SIZE_LIMIT} lines are classified.`,
  );
  return 0;
}

if (import.meta.main) {
  const exitCode = await runCli(process.argv.slice(2));
  process.exit(exitCode);
}

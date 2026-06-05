/**
 * In-memory JSDoc manifest builder.
 *
 * Replaces the on-disk reference/jsdoc-manifest.json artifact. Every consumer
 * (audit, check-declaration, extract-doctests, extract-markdown-doctests) calls
 * buildManifest() at start-up and gets the same structure that used to be
 * persisted, classified, and read back.
 *
 * The manifest is fully derivable from package.json `exports`, source `.ts`
 * files, and the prose-only name pattern below — there are no per-entry manual
 * overrides, so nothing needs to be checked in.
 */

import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';

const REPO_ROOT = resolve(import.meta.dir, '../..');
const PACKAGE_JSON = resolve(REPO_ROOT, 'package.json');

export type SymbolKind = 'value' | 'type' | 'namespace';
export type Classification = 'unclassified' | 'example-required' | 'prose-only' | 'not-public';

export type PublicFace = {
  importPath: string;
  exportName: string;
  kind: SymbolKind;
};

export type ManifestEntry = {
  sourceFile: string;
  sourceName: string;
  kind: SymbolKind;
  subKind: string;
  publicFaces: PublicFace[];
  classification: Classification;
};

export type Manifest = {
  publicEntryPoints: Record<string, string>;
  entries: ManifestEntry[];
};

// ---------------------------------------------------------------------------
// Prose-only classification rule. The classifier uses this regex to decide
// whether a `type` entry (returned/read-only by users, never constructed) gets
// classified as prose-only instead of example-required. False positives get
// hand-corrected by editing the regex; there is no per-entry override file.
// ---------------------------------------------------------------------------

const PROSE_ONLY_NAME_PATTERN =
  /^(ActivityCompletedInterception|ActivityFailedInterception|AlertAction|AlertState|AnnotateResult|BatchOperation|BudgetState|BulkCancelResult|BulkDeleteResult|BulkOperationError|BulkSignalResult|BulkTagResult|CheckpointState|CheckpointSummary|ChildWorkflowOptions|ConditionalBatchCondition|ConstraintCheckState|ConstraintViolation|CoordinatedUpdateResult|DatabaseHealth|DiagnosticReport|FieldDiff|ForkLineage|HealthStatus|InvocationResult|JSONValue|KnownWorkflowName|LargestCheckpoint|LongestRunningWorkflow|MemoryProfile|MemorySample|MessagePackValue|NeonPool|NeonPoolClient|NormalizedRetentionPolicy|PaginatedResult|PrometheusExporter|PurgeResult|QueueStatistics|Recommendation|RecommendationSeverity|ReviewDecision|RoutingPolicy|RuntimeKind|ScheduleAccessOptions|ScheduleFilter|ScheduleState|ScheduleStatus|ScheduleSummary|SchedulingPolicy|SerializedBudgetState|ShapeDescriptor|ShapeDiffOptions|StabilityResult|StorageSizeReport|StorageValueParser|StoredStreamChunk|TenantQuotaMetricUsage|TenantQuotaUsage|TenantWorkflowCreationRateUsage|UnknownNameWhenRegistryEmpty|UpdateResult|VersionCheckReport|WorkflowEvent|WorkflowReplay|WorkflowSessionState|WorkflowState|WorkflowStatistics|WorkflowStatus|WorkflowStatusCounts|WorkflowSummary|WorkflowTimelineEntry|WorkflowTimelineStatus|WorkflowTypeReport)$/;

// ---------------------------------------------------------------------------
// package.json `exports` reading.
// ---------------------------------------------------------------------------

type PackageJson = { name: string; exports?: Record<string, unknown> };

function loadPackageJson(): PackageJson {
  return JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
}

function distToSource(distRelative: string): string {
  return distRelative
    .replace(/^\.\//, '')
    .replace(/^dist\//, 'src/')
    .replace(/\.d\.ts$/, '.ts');
}

function pickTypesField(value: unknown): string | null {
  if (typeof value === 'string') return null;
  if (value === null || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj['types'] === 'string') return obj['types'];
  for (const key of ['bun', 'node', 'import', 'default'] as const) {
    const inner = obj[key];
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
      const innerTypes = (inner as Record<string, unknown>)['types'];
      if (typeof innerTypes === 'string') return null;
    }
  }
  return null;
}

function buildPublicEntryPoints(pkg: PackageJson): Record<string, string> {
  if (!pkg.exports) {
    throw new Error('package.json missing `exports` map');
  }
  const out: Record<string, string> = {};
  for (const [subpath, value] of Object.entries(pkg.exports)) {
    const importPath = subpath === '.' ? pkg.name : `${pkg.name}/${subpath.replace(/^\.\//, '')}`;
    const typesPath = pickTypesField(value);
    if (typesPath) {
      const sourcePath = distToSource(typesPath);
      out[importPath] = relative(REPO_ROOT, resolve(REPO_ROOT, sourcePath));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// TypeScript program loading.
// ---------------------------------------------------------------------------

function loadProgram(rootFiles: string[]): ts.Program {
  const config = ts.findConfigFile(REPO_ROOT, ts.sys.fileExists.bind(ts.sys), 'tsconfig.json');
  if (!config) throw new Error('tsconfig.json not found');
  const parsed = ts.readConfigFile(config, ts.sys.readFile.bind(ts.sys));
  if (parsed.error)
    throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n'));
  const compilerOptions = ts.parseJsonConfigFileContent(
    parsed.config,
    ts.sys,
    dirname(config),
  ).options;
  return ts.createProgram(rootFiles, { ...compilerOptions, noEmit: true });
}

function symbolKind(symbol: ts.Symbol): { kind: SymbolKind; subKind: string } {
  const flags = symbol.flags;
  if (flags & ts.SymbolFlags.Class) return { kind: 'value', subKind: 'class' };
  if (flags & ts.SymbolFlags.Enum) return { kind: 'value', subKind: 'enum' };
  if (flags & ts.SymbolFlags.Function) return { kind: 'value', subKind: 'function' };
  if (flags & ts.SymbolFlags.Variable) return { kind: 'value', subKind: 'const' };
  if (flags & ts.SymbolFlags.Interface) return { kind: 'type', subKind: 'interface' };
  if (flags & ts.SymbolFlags.TypeAlias) return { kind: 'type', subKind: 'type-alias' };
  if (flags & ts.SymbolFlags.Module || flags & ts.SymbolFlags.Namespace) {
    return { kind: 'namespace', subKind: 'namespace' };
  }
  if (flags & ts.SymbolFlags.Type) return { kind: 'type', subKind: 'type' };
  if (flags & ts.SymbolFlags.Value) return { kind: 'value', subKind: 'value' };
  return { kind: 'value', subKind: 'unknown' };
}

// ---------------------------------------------------------------------------
// Resolve a re-exported symbol back to its source declaration. Handles alias
// chains and the Bun-barrel `const exportedX = X; export { exportedX as X }`
// pattern.
// ---------------------------------------------------------------------------

function resolveToSourceDeclaration(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
): {
  sourceFile: string;
  sourceName: string;
  kind: SymbolKind;
  subKind: string;
} | null {
  let current = symbol;
  while (current.flags & ts.SymbolFlags.Alias) {
    const next = checker.getAliasedSymbol(current);
    if (!next || next === current) break;
    current = next;
  }
  const seen = new Set<ts.Symbol>();
  while (
    current.flags & ts.SymbolFlags.Variable &&
    !seen.has(current) &&
    current.declarations &&
    current.declarations.length > 0
  ) {
    seen.add(current);
    const variableDeclaration = current.declarations.find(ts.isVariableDeclaration);
    if (!variableDeclaration) break;
    const initializer = variableDeclaration.initializer;
    if (initializer === undefined || !ts.isIdentifier(initializer)) break;
    const initializerSymbol = checker.getSymbolAtLocation(initializer);
    if (!initializerSymbol || initializerSymbol === current) break;
    let next = initializerSymbol;
    while (next.flags & ts.SymbolFlags.Alias) {
      const aliased = checker.getAliasedSymbol(next);
      if (!aliased || aliased === next) break;
      next = aliased;
    }
    if (next === current) break;
    current = next;
  }
  const decls = current.declarations ?? [];
  if (decls.length === 0) return null;
  const decl = decls.find((d) => !ts.isExportSpecifier(d) && !ts.isExportAssignment(d)) ?? decls[0];
  const sourceFile = relative(REPO_ROOT, decl.getSourceFile().fileName);
  if (sourceFile.startsWith('..') || sourceFile.includes('node_modules')) return null;
  const { kind, subKind } = symbolKind(current);
  return {
    sourceFile,
    sourceName: current.getName(),
    kind,
    subKind,
  };
}

function entryKey(sourceFile: string, sourceName: string, kind: SymbolKind): string {
  return `${sourceFile}|${sourceName}|${kind}`;
}

// ---------------------------------------------------------------------------
// Pass 1 — public-face discovery from each entry-point source file.
// ---------------------------------------------------------------------------

function runPass1(
  publicEntryPoints: Record<string, string>,
  program: ts.Program,
): Map<string, ManifestEntry> {
  const checker = program.getTypeChecker();
  const entries = new Map<string, ManifestEntry>();

  for (const [importPath, sourceRelative] of Object.entries(publicEntryPoints)) {
    const absoluteEntry = resolve(REPO_ROOT, sourceRelative);
    const entrySourceFile = program.getSourceFile(absoluteEntry);
    if (!entrySourceFile) {
      throw new Error(
        `buildManifest: source file for export '${importPath}' not found at ${sourceRelative}. Check package.json \`exports\` and ensure the source file exists.`,
      );
    }
    const moduleSymbol = checker.getSymbolAtLocation(entrySourceFile);
    if (!moduleSymbol) {
      throw new Error(
        `buildManifest: no module symbol for export '${importPath}' (${sourceRelative}). The TypeScript program could not resolve this file as a module.`,
      );
    }
    const exports = checker.getExportsOfModule(moduleSymbol);
    for (const exportSymbol of exports) {
      const exportName = exportSymbol.getName();
      const resolved = resolveToSourceDeclaration(exportSymbol, checker);
      if (!resolved) continue;
      const key = entryKey(resolved.sourceFile, resolved.sourceName, resolved.kind);
      let entry = entries.get(key);
      if (!entry) {
        entry = {
          sourceFile: resolved.sourceFile,
          sourceName: resolved.sourceName,
          kind: resolved.kind,
          subKind: resolved.subKind,
          publicFaces: [],
          classification: 'unclassified',
        };
        entries.set(key, entry);
      }
      const faceKind = resolved.kind;
      const faceTuple: PublicFace = { importPath, exportName, kind: faceKind };
      const dup = entry.publicFaces.some(
        (f) => f.importPath === importPath && f.exportName === exportName && f.kind === faceKind,
      );
      if (!dup) entry.publicFaces.push(faceTuple);
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Pass 2 — source enumeration. Adds entries with publicFaces:[] for any
// exported declaration not reached in Pass 1.
// ---------------------------------------------------------------------------

function runPass2(entries: Map<string, ManifestEntry>, program: ts.Program): void {
  const checker = program.getTypeChecker();
  const sourceFiles = new Set<string>();
  for (const entry of entries.values()) sourceFiles.add(entry.sourceFile);

  for (const sourceRelative of sourceFiles) {
    const absoluteSource = resolve(REPO_ROOT, sourceRelative);
    const sourceFile = program.getSourceFile(absoluteSource);
    if (!sourceFile) continue;
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) continue;
    const exports = checker.getExportsOfModule(moduleSymbol);
    for (const exportSymbol of exports) {
      const resolved = resolveToSourceDeclaration(exportSymbol, checker);
      if (!resolved) continue;
      if (resolved.sourceFile !== sourceRelative) continue;
      const key = entryKey(resolved.sourceFile, resolved.sourceName, resolved.kind);
      if (entries.has(key)) continue;
      entries.set(key, {
        sourceFile: resolved.sourceFile,
        sourceName: resolved.sourceName,
        kind: resolved.kind,
        subKind: resolved.subKind,
        publicFaces: [],
        classification: 'unclassified',
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Apply classification rules. publicFaces.length === 0 -> not-public; type
// entries matching the prose-only name pattern -> prose-only; everything else
// -> example-required.
// ---------------------------------------------------------------------------

function classify(entry: ManifestEntry): Classification {
  if (entry.publicFaces.length === 0) return 'not-public';
  if (entry.kind === 'type' && PROSE_ONLY_NAME_PATTERN.test(entry.sourceName)) return 'prose-only';
  return 'example-required';
}

// ---------------------------------------------------------------------------
// Public entry point: build a fully-classified manifest in memory.
// ---------------------------------------------------------------------------

export function buildManifest(): Manifest {
  const pkg = loadPackageJson();
  const publicEntryPoints = buildPublicEntryPoints(pkg);
  const rootFiles = Object.values(publicEntryPoints).map((p) => resolve(REPO_ROOT, p));
  const program = loadProgram(rootFiles);

  const entriesMap = runPass1(publicEntryPoints, program);
  runPass2(entriesMap, program);

  const sorted = [...entriesMap.values()].toSorted((a, b) => {
    if (a.sourceFile !== b.sourceFile) return a.sourceFile < b.sourceFile ? -1 : 1;
    if (a.sourceName !== b.sourceName) return a.sourceName < b.sourceName ? -1 : 1;
    return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
  });

  for (const entry of sorted) {
    entry.publicFaces = entry.publicFaces.toSorted((a, b) => {
      if (a.importPath !== b.importPath) return a.importPath < b.importPath ? -1 : 1;
      if (a.exportName !== b.exportName) return a.exportName < b.exportName ? -1 : 1;
      return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
    });
    entry.classification = classify(entry);
  }

  return { publicEntryPoints, entries: sorted };
}

// Re-export the regex so debugging tools can introspect the classification rule.
export { PROSE_ONLY_NAME_PATTERN };

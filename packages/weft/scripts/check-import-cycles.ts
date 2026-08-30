/**
 * Detects runtime import cycles between TypeScript files in `src/`.
 *
 * This script is intended to run as part of `bun run lint`, after normal lint
 * checks have had a chance to catch syntax and style issues. It ignores
 * type-only imports and exports so architectural checks only cover dependencies
 * that can affect runtime module initialization.
 *
 * To update the allowlist, run the script with `--update` (e.g. via
 * `bun run scripts/check-import-cycles.ts --update`). In the default path
 * (`bun run lint`), an empty allowlist is treated as "zero cycles permitted"
 * and the script will exit 1 if any cycles are found.
 */

import { Glob, file, write } from 'bun';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

type ImportGraph = Map<string, Set<string>>;

const updateMode = process.argv.includes('--update');
const repositoryRoot = resolve(import.meta.dir, '..');
const sourceRoot = join(repositoryRoot, 'src');
const allowlistPath = join(repositoryRoot, 'documentation/import-cycle-allowlist.json');

function toRepositoryPath(absolutePath: string): string {
  return relative(repositoryRoot, absolutePath).split('\\').join('/');
}

function isSkippedSourceFile(repositoryPath: string): boolean {
  return (
    repositoryPath.endsWith('.test.ts') ||
    repositoryPath.endsWith('.spec.ts') ||
    repositoryPath.includes('/test/') ||
    repositoryPath.includes('/__tests__/')
  );
}

function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

function isWithinSourceRoot(absolutePath: string): boolean {
  const sourceRelativePath = relative(sourceRoot, absolutePath);
  return !sourceRelativePath.startsWith('..');
}

function getStringModuleSpecifier(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node)) {
    return node.text;
  }

  return undefined;
}

function importDeclarationHasRuntimeEdge(node: ts.ImportDeclaration): boolean {
  const importClause = node.importClause;

  if (!importClause) {
    return true;
  }

  if (importClause.isTypeOnly) {
    return false;
  }

  if (importClause.name) {
    return true;
  }

  const namedBindings = importClause.namedBindings;
  if (!namedBindings) {
    return true;
  }

  if (ts.isNamespaceImport(namedBindings)) {
    return true;
  }

  if (namedBindings.elements.length === 0) {
    return true;
  }

  return namedBindings.elements.some((specifier) => !specifier.isTypeOnly);
}

function exportDeclarationHasRuntimeEdge(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) {
    return false;
  }

  const exportClause = node.exportClause;
  if (!exportClause) {
    return true;
  }

  if (ts.isNamespaceExport(exportClause)) {
    return true;
  }

  if (exportClause.elements.length === 0) {
    return true;
  }

  return exportClause.elements.some((specifier) => !specifier.isTypeOnly);
}

function resolveRuntimeSpecifier(
  importerPath: string,
  specifier: string,
  sourceFiles: ReadonlySet<string>,
): string | undefined {
  if (!isRelativeSpecifier(specifier)) {
    return undefined;
  }

  const withoutExtension = resolve(dirname(importerPath), specifier);
  const candidates = [withoutExtension, `${withoutExtension}.ts`];

  for (const candidate of candidates) {
    if (isWithinSourceRoot(candidate) && sourceFiles.has(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

async function findSourceFiles(): Promise<string[]> {
  const sourceFiles: string[] = [];
  const glob = new Glob('src/**/*.ts');

  for await (const discoveredPath of glob.scan({ absolute: true, cwd: repositoryRoot })) {
    const repositoryPath = toRepositoryPath(discoveredPath);

    if (!isSkippedSourceFile(repositoryPath)) {
      sourceFiles.push(discoveredPath);
    }
  }

  return sourceFiles.toSorted((left, right) => {
    const leftPath = toRepositoryPath(left);
    const rightPath = toRepositoryPath(right);

    return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
  });
}

function collectRuntimeEdgesFromSourceFile(
  sourceFile: ts.SourceFile,
  importerPath: string,
  sourceFiles: ReadonlySet<string>,
): Set<string> {
  const edges = new Set<string>();

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && importDeclarationHasRuntimeEdge(node)) {
      const specifier = getStringModuleSpecifier(node.moduleSpecifier);
      const resolvedSpecifier = specifier
        ? resolveRuntimeSpecifier(importerPath, specifier, sourceFiles)
        : undefined;

      if (resolvedSpecifier) {
        edges.add(resolvedSpecifier);
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      exportDeclarationHasRuntimeEdge(node)
    ) {
      const specifier = getStringModuleSpecifier(node.moduleSpecifier);
      const resolvedSpecifier = specifier
        ? resolveRuntimeSpecifier(importerPath, specifier, sourceFiles)
        : undefined;

      if (resolvedSpecifier) {
        edges.add(resolvedSpecifier);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return edges;
}

async function buildImportGraph(sourceFiles: readonly string[]): Promise<ImportGraph> {
  const sourceFileSet = new Set(sourceFiles);
  const graph: ImportGraph = new Map(
    sourceFiles.map((sourceFile) => [sourceFile, new Set<string>()]),
  );

  for (const sourceFilePath of sourceFiles) {
    const sourceText = await file(sourceFilePath).text();
    const sourceFile = ts.createSourceFile(
      sourceFilePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    graph.set(
      sourceFilePath,
      collectRuntimeEdgesFromSourceFile(sourceFile, sourceFilePath, sourceFileSet),
    );
  }

  return graph;
}

function getRequiredMapValue<Key, Value>(
  map: ReadonlyMap<Key, Value>,
  key: Key,
  label: string,
): Value {
  const value = map.get(key);

  if (value === undefined) {
    throw new Error(`Missing ${label}`);
  }

  return value;
}

function findStronglyConnectedComponents(
  graph: ReadonlyMap<string, ReadonlySet<string>>,
): string[][] {
  let nextIndex = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const components: string[][] = [];

  function connect(vertex: string): void {
    indices.set(vertex, nextIndex);
    lowlinks.set(vertex, nextIndex);
    nextIndex += 1;
    stack.push(vertex);
    onStack.add(vertex);

    for (const neighbor of graph.get(vertex) ?? []) {
      if (!indices.has(neighbor)) {
        connect(neighbor);
        const vertexLowlink = getRequiredMapValue(lowlinks, vertex, 'vertex lowlink');
        const neighborLowlink = getRequiredMapValue(lowlinks, neighbor, 'neighbor lowlink');
        lowlinks.set(vertex, Math.min(vertexLowlink, neighborLowlink));
      } else if (onStack.has(neighbor)) {
        const vertexLowlink = getRequiredMapValue(lowlinks, vertex, 'vertex lowlink');
        const neighborIndex = getRequiredMapValue(indices, neighbor, 'neighbor index');
        lowlinks.set(vertex, Math.min(vertexLowlink, neighborIndex));
      }
    }

    const vertexLowlink = getRequiredMapValue(lowlinks, vertex, 'vertex lowlink');
    const vertexIndex = getRequiredMapValue(indices, vertex, 'vertex index');

    if (vertexLowlink !== vertexIndex) {
      return;
    }

    const component: string[] = [];
    let poppedVertex: string | undefined;

    do {
      poppedVertex = stack.pop();

      if (!poppedVertex) {
        throw new Error('Tarjan stack underflow');
      }

      onStack.delete(poppedVertex);
      component.push(poppedVertex);
    } while (poppedVertex !== vertex);

    components.push(component);
  }

  for (const vertex of graph.keys()) {
    if (!indices.has(vertex)) {
      connect(vertex);
    }
  }

  return components;
}

function compareCyclePaths(left: readonly string[], right: readonly string[]): number {
  const length = Math.min(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    const leftPath = left[index];
    const rightPath = right[index];

    if (leftPath === undefined || rightPath === undefined) {
      break;
    }

    const comparison = leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;

    if (comparison !== 0) {
      return comparison;
    }
  }

  return left.length - right.length;
}

function rotateCycle(cycle: readonly string[], startIndex: number): string[] {
  if (startIndex < 0) {
    return [];
  }

  const withoutClosingPath = cycle.slice(0, -1);
  const rotated = [
    ...withoutClosingPath.slice(startIndex),
    ...withoutClosingPath.slice(0, startIndex),
  ];
  const firstPath = rotated[0];

  if (!firstPath) {
    return [];
  }

  return [...rotated, firstPath];
}

function normalizeCycle(cycle: readonly string[]): string[] {
  const withoutClosingPath = cycle.at(0) === cycle.at(-1) ? cycle.slice(0, -1) : [...cycle];
  const firstPath = withoutClosingPath[0];

  if (!firstPath) {
    return [];
  }

  const closedCycle = [...withoutClosingPath, firstPath];
  const smallestPath = withoutClosingPath.reduce((smallest, cyclePath) =>
    cyclePath < smallest ? cyclePath : smallest,
  );
  const reversedCycle = closedCycle.slice(0, -1).toReversed();
  const reversedFirstPath = reversedCycle[0];
  const closedReversedCycle = reversedFirstPath ? [...reversedCycle, reversedFirstPath] : [];

  const forwardStartIndex = closedCycle.findIndex((cyclePath) => cyclePath === smallestPath);
  const reverseStartIndex = closedReversedCycle.findIndex(
    (cyclePath) => cyclePath === smallestPath,
  );
  const forwardRotation = rotateCycle(closedCycle, forwardStartIndex);
  const reverseRotation = rotateCycle(closedReversedCycle, reverseStartIndex);

  return compareCyclePaths(reverseRotation, forwardRotation) < 0
    ? reverseRotation
    : forwardRotation;
}

function detectCycles(graph: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  return findStronglyConnectedComponents(graph)
    .filter((component) => {
      if (component.length > 1) {
        return true;
      }

      const onlyPath = component[0];
      return onlyPath ? graph.get(onlyPath)?.has(onlyPath) === true : false;
    })
    .map((component) => normalizeCycle(component.map(toRepositoryPath).toSorted()))
    .toSorted(compareCyclePaths);
}

function cycleKey(cycle: readonly string[]): string {
  return normalizeCycle(cycle).join('\n');
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isAllowlist(value: unknown): value is string[][] {
  return Array.isArray(value) && value.every(isStringArray);
}

async function readAllowlistedCycles(): Promise<{ cycles: string[][]; missingOrEmpty: boolean }> {
  const allowlistFile = file(allowlistPath);

  if (!(await allowlistFile.exists())) {
    return { cycles: [], missingOrEmpty: true };
  }

  const text = await allowlistFile.text();

  if (text.trim() === '') {
    return { cycles: [], missingOrEmpty: true };
  }

  const parsedJson: unknown = JSON.parse(text);

  if (!isAllowlist(parsedJson)) {
    throw new Error('documentation/import-cycle-allowlist.json must be an array of string arrays.');
  }

  return {
    cycles: parsedJson.map(normalizeCycle).toSorted(compareCyclePaths),
    missingOrEmpty: false,
  };
}

async function writeAllowlistedCycles(cycles: readonly string[][]): Promise<void> {
  await write(allowlistPath, `${JSON.stringify(cycles, null, 2)}\n`);
}

function formatCycle(cycle: readonly string[]): string {
  return cycle.map((cyclePath) => `  - ${cyclePath}`).join('\n');
}

const sourceFiles = await findSourceFiles();
const graph = await buildImportGraph(sourceFiles);
const cycles = detectCycles(graph);
const { cycles: allowlistedCycles, missingOrEmpty } = await readAllowlistedCycles();

if (missingOrEmpty) {
  if (!updateMode) {
    process.stderr.write(
      'documentation/import-cycle-allowlist.json is missing or empty. ' +
        'Run with --update to initialize the baseline.\n',
    );
    process.exit(1);
  }

  await writeAllowlistedCycles(cycles);

  if (cycles.length > 0) {
    process.stdout.write(
      `Baseline: wrote ${cycles.length} import cycle(s) to documentation/import-cycle-allowlist.json.\n`,
    );
    process.exit(0);
  }
}

const currentCycleKeys = new Set(cycles.map(cycleKey));
const allowlistedCycleKeys = new Set(allowlistedCycles.map(cycleKey));
const newCycles = cycles.filter((cycle) => !allowlistedCycleKeys.has(cycleKey(cycle)));
const staleAllowlistedCycles = allowlistedCycles.filter(
  (cycle) => !currentCycleKeys.has(cycleKey(cycle)),
);

if (newCycles.length > 0 || staleAllowlistedCycles.length > 0) {
  for (const cycle of newCycles) {
    process.stderr.write(`New import cycle detected:\n${formatCycle(cycle)}\n`);
  }

  for (const cycle of staleAllowlistedCycles) {
    process.stderr.write(
      `Allowlisted import cycle no longer exists; remove it:\n${formatCycle(cycle)}\n`,
    );
  }

  process.exit(1);
}

if (cycles.length === 0) {
  process.stdout.write('OK: no import cycles detected.\n');
} else {
  process.stdout.write(`OK: ${cycles.length} cycle(s) on allowlist; no new cycles.\n`);
}

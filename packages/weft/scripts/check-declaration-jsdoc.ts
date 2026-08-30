/**
 * Asserts that emitted .d.ts declaration files retain the JSDoc that consumers
 * see in IDE hover for every relevant manifest entry.
 *
 * Selectors:
 *   --all              every manifest entry where classification != 'not-public'.
 *                      Requires the manifest to be classified — script exits
 *                      non-zero on any 'unclassified' entry.
 *   --symbols <list>   comma-separated list of <importPath>#<exportName>#<kind>
 *                      triples. Works on any manifest state (does not require
 *                      classification, because the caller asserts which symbols
 *                      to check).
 *
 * The script normalizes each importPath to its package.json `exports` key
 * (strip package-name prefix: '@lostgradient/weft' -> '.', '@lostgradient/weft/storage/memory' ->
 * './storage/memory'), reads exports[<key>].types to locate the .d.ts file,
 * uses ts.createProgram + ts.TypeChecker to follow alias chains to the
 * underlying declaration, selects the namespace partition matching kind, and
 * reads JSDoc via ts.getJSDocTags() plus the leading description text.
 *
 * Assertion rule:
 *   - example-required (post-classification) -> non-empty description AND
 *     at least one @example tag.
 *   - prose-only (post-classification)       -> non-empty description.
 *   - unclassified (pre-classification, only via --symbols) -> derive from
 *     currentState: has-example -> prose+example, prose-only -> prose,
 *     no-jsdoc -> always fail.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

import {
  buildManifest,
  loadPackageJson,
  pickTypesField,
  type Classification,
  type Manifest,
  type ManifestEntry,
  type PackageJson as PkgJson,
  type SymbolKind,
} from './lib/jsdoc-manifest.ts';

const REPO_ROOT = resolve(import.meta.dir, '..');

type CurrentState = 'no-jsdoc' | 'prose-only' | 'has-example';

// ---------------------------------------------------------------------------
// CLI parsing.
// ---------------------------------------------------------------------------

type Selector = { mode: 'all' } | { mode: 'symbols'; triples: string[] };

function parseArgs(argv: string[]): Selector {
  if (argv.includes('--all')) return { mode: 'all' };
  const symbolsIdx = argv.indexOf('--symbols');
  if (symbolsIdx >= 0 && argv[symbolsIdx + 1]) {
    const list = argv[symbolsIdx + 1];
    const triples = list
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return { mode: 'symbols', triples };
  }
  console.error(
    'check-declaration-jsdoc: usage: --all | --symbols <importPath>#<exportName>#<kind>,...',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// package.json `exports` lookup with key normalization.
// ---------------------------------------------------------------------------

function loadCompilerOptions(): ts.CompilerOptions {
  const config = ts.findConfigFile(REPO_ROOT, ts.sys.fileExists.bind(ts.sys), 'tsconfig.json');
  if (!config) throw new Error('tsconfig.json not found');
  const parsed = ts.readConfigFile(config, ts.sys.readFile.bind(ts.sys));
  if (parsed.error) {
    throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n'));
  }
  return ts.parseJsonConfigFileContent(parsed.config, ts.sys, dirname(config)).options;
}

function normalizeExportKey(importPath: string, packageName: string): string {
  if (importPath === packageName) return '.';
  if (importPath.startsWith(`${packageName}/`)) {
    return `./${importPath.slice(packageName.length + 1)}`;
  }
  throw new Error(`importPath ${importPath} does not start with package name ${packageName}`);
}

function declarationFileFor(importPath: string, pkg: PkgJson): string {
  if (!pkg.exports) throw new Error('package.json missing `exports` map');
  const key = normalizeExportKey(importPath, pkg.name);
  const value = pkg.exports[key];
  if (value === undefined) throw new Error(`No exports entry for key ${key}`);
  const typesPath = pickTypesField(value);
  if (!typesPath) throw new Error(`exports[${key}] has no .types field`);
  return resolve(REPO_ROOT, typesPath.replace(/^\.\//, ''));
}

// ---------------------------------------------------------------------------
// Symbol kind matcher.
// ---------------------------------------------------------------------------

function symbolMatchesKind(symbol: ts.Symbol, kind: SymbolKind): boolean {
  const f = symbol.flags;
  if (kind === 'namespace') {
    return Boolean(f & (ts.SymbolFlags.Module | ts.SymbolFlags.Namespace));
  }
  if (kind === 'value') {
    return Boolean(
      f &
      (ts.SymbolFlags.Class |
        ts.SymbolFlags.Function |
        ts.SymbolFlags.Variable |
        ts.SymbolFlags.Enum |
        ts.SymbolFlags.EnumMember |
        ts.SymbolFlags.ConstEnum |
        ts.SymbolFlags.Value),
    );
  }
  // type
  return Boolean(
    f &
    (ts.SymbolFlags.Interface |
      ts.SymbolFlags.TypeAlias |
      ts.SymbolFlags.TypeParameter |
      ts.SymbolFlags.Type),
  );
}

// ---------------------------------------------------------------------------
// JSDoc inspection on emitted declarations.
// ---------------------------------------------------------------------------

type JsDocState = { hasProse: boolean; hasExample: boolean };

function jsdocStateForSymbol(symbol: ts.Symbol, checker: ts.TypeChecker): JsDocState {
  // Resolve aliases to follow re-exports.
  let underlying = symbol;
  while (underlying.flags & ts.SymbolFlags.Alias) {
    const next = checker.getAliasedSymbol(underlying);
    if (!next || next === underlying) break;
    underlying = next;
  }

  let hasProse = false;
  let hasExample = false;
  const decls = underlying.declarations ?? [];
  for (const decl of decls) {
    const tags = ts.getJSDocTags(decl);
    if (tags.some((t) => t.tagName.text === 'example')) hasExample = true;
    const jsdocComments = ts.getJSDocCommentsAndTags(decl);
    let proseText = '';
    for (const node of jsdocComments) {
      if (ts.isJSDoc(node)) {
        const comment = node.comment;
        if (typeof comment === 'string') proseText += comment;
        else if (Array.isArray(comment)) {
          for (const part of comment) {
            if (part.kind === ts.SyntaxKind.JSDocText) {
              proseText += part.text;
            }
          }
        }
      }
    }
    if (proseText.trim().length > 0) hasProse = true;
  }
  return { hasProse, hasExample };
}

// ---------------------------------------------------------------------------
// Resolve a (importPath, exportName, kind) triple to a symbol via the emitted
// declaration file. Returns the JsDocState or null on resolution failure.
// ---------------------------------------------------------------------------

function resolveTriple(
  triple: string,
  pkg: PkgJson,
  programs: Map<
    string,
    { program: ts.Program; checker: ts.TypeChecker; sourceFile: ts.SourceFile }
  >,
): { state: JsDocState | null; reason?: string } {
  const parts = triple.split('#');
  if (parts.length !== 3) {
    return {
      state: null,
      reason: `bad triple format (expected importPath#exportName#kind): ${triple}`,
    };
  }
  const [importPath, exportName, kindStr] = parts as [string, string, string];
  if (kindStr !== 'value' && kindStr !== 'type' && kindStr !== 'namespace') {
    return { state: null, reason: `bad kind in triple ${triple}` };
  }
  const kind = kindStr;
  let dtsPath: string;
  try {
    dtsPath = declarationFileFor(importPath, pkg);
  } catch (err) {
    return { state: null, reason: `${triple}: ${(err as Error).message}` };
  }
  if (!existsSync(dtsPath)) {
    return {
      state: null,
      reason: `${triple}: declaration file ${dtsPath} not found (run \`bun run build\` first)`,
    };
  }
  let cached = programs.get(dtsPath);
  if (!cached) {
    const program = ts.createProgram([dtsPath], {
      target: ts.ScriptTarget.Latest,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      skipLibCheck: true,
      allowJs: false,
    });
    const checker = program.getTypeChecker();
    const sourceFile = program.getSourceFile(dtsPath);
    if (!sourceFile) return { state: null, reason: `${triple}: program could not load ${dtsPath}` };
    cached = { program, checker, sourceFile };
    programs.set(dtsPath, cached);
  }
  const moduleSymbol = cached.checker.getSymbolAtLocation(cached.sourceFile);
  if (!moduleSymbol) return { state: null, reason: `${triple}: no module symbol for ${dtsPath}` };
  const exports = cached.checker.getExportsOfModule(moduleSymbol);
  const checker = cached.checker;
  const matching = exports.filter((s) => {
    if (s.getName() !== exportName) return false;
    // Resolve aliases (re-exports) before checking flags.
    let underlying = s;
    while (underlying.flags & ts.SymbolFlags.Alias) {
      const next = checker.getAliasedSymbol(underlying);
      if (!next || next === underlying) break;
      underlying = next;
    }
    return symbolMatchesKind(underlying, kind);
  });
  if (matching.length === 0) {
    return {
      state: null,
      reason: `${triple}: no export named ${exportName} of kind ${kind} in ${dtsPath}`,
    };
  }
  // If multiple symbols match (e.g. a class is both value and type), pick first.
  return { state: jsdocStateForSymbol(matching[0], cached.checker) };
}

// ---------------------------------------------------------------------------
// Main entry point.
// ---------------------------------------------------------------------------

type PopulationItem = {
  triple: string;
  classification: Classification;
  // currentState is re-derived per-item from source declarations (not read
  // from the manifest, which no longer persists this field). Only consulted
  // when classification === 'unclassified'.
  sourceFile: string;
  sourceName: string;
  kind: SymbolKind;
};

function buildPopulation(selector: Selector, manifest: Manifest): PopulationItem[] {
  if (selector.mode === 'all') return populationAll(manifest);
  return populationSymbols(selector.triples, manifest);
}

function populationAll(manifest: Manifest): PopulationItem[] {
  const unclassified = manifest.entries.filter((e) => e.classification === 'unclassified');
  if (unclassified.length > 0) {
    console.error(
      `check-declaration-jsdoc: manifest contains ${unclassified.length} unclassified entries; use --symbols or run after classification`,
    );
    process.exit(1);
  }
  const out: PopulationItem[] = [];
  for (const entry of manifest.entries) {
    if (entry.classification === 'not-public') continue;
    for (const face of entry.publicFaces) {
      out.push({
        triple: `${face.importPath}#${face.exportName}#${face.kind}`,
        classification: entry.classification,
        sourceFile: entry.sourceFile,
        sourceName: entry.sourceName,
        kind: entry.kind,
      });
    }
  }
  return out;
}

function populationSymbols(triples: string[], manifest: Manifest): PopulationItem[] {
  const byTriple = new Map<string, ManifestEntry>();
  for (const entry of manifest.entries) {
    for (const face of entry.publicFaces) {
      byTriple.set(`${face.importPath}#${face.exportName}#${face.kind}`, entry);
    }
  }
  const out: PopulationItem[] = [];
  for (const triple of triples) {
    const entry = byTriple.get(triple);
    if (!entry) {
      console.error(`check-declaration-jsdoc: triple ${triple} not found in manifest publicFaces`);
      process.exit(1);
    }
    out.push({
      triple,
      classification: entry.classification,
      sourceFile: entry.sourceFile,
      sourceName: entry.sourceName,
      kind: entry.kind,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Re-derive currentState from source declarations (used only for unclassified
// entries — classified entries get their assertion rule from `classification`,
// so they never need this).
// ---------------------------------------------------------------------------

function detectCurrentStateFromSource(
  sourceFile: string,
  sourceName: string,
  kind: SymbolKind,
  cache: Map<string, { program: ts.Program; checker: ts.TypeChecker; sourceFile: ts.SourceFile }>,
  compilerOptions: ts.CompilerOptions,
): CurrentState {
  const absolute = resolve(REPO_ROOT, sourceFile);
  let cached = cache.get(absolute);
  if (!cached) {
    if (!existsSync(absolute)) return 'no-jsdoc';
    const program = ts.createProgram([absolute], { ...compilerOptions, noEmit: true });
    const checker = program.getTypeChecker();
    const parsedSourceFile = program.getSourceFile(absolute);
    if (!parsedSourceFile) return 'no-jsdoc';
    cached = { program, checker, sourceFile: parsedSourceFile };
    cache.set(absolute, cached);
  }
  const moduleSymbol = cached.checker.getSymbolAtLocation(cached.sourceFile);
  if (!moduleSymbol) return 'no-jsdoc';
  const exportSymbol = cached.checker.getExportsOfModule(moduleSymbol).find((symbol) => {
    if (symbol.getName() !== sourceName) return false;
    let underlying = symbol;
    while (underlying.flags & ts.SymbolFlags.Alias) {
      const next = cached.checker.getAliasedSymbol(underlying);
      if (!next || next === underlying) break;
      underlying = next;
    }
    return symbolMatchesKind(underlying, kind);
  });
  if (!exportSymbol) return 'no-jsdoc';
  const state = jsdocStateForSymbol(exportSymbol, cached.checker);
  if (state.hasProse && state.hasExample) return 'has-example';
  if (state.hasProse) return 'prose-only';
  return 'no-jsdoc';
}

type AssertionRule = { requireProse: boolean; requireExample: boolean } | { fail: string };

function pickAssertionRule(item: PopulationItem, currentState: CurrentState): AssertionRule {
  if (item.classification === 'example-required') {
    return { requireProse: true, requireExample: true };
  }
  if (item.classification === 'prose-only') {
    return { requireProse: true, requireExample: false };
  }
  // unclassified — derive from currentState (re-read from source per item).
  if (currentState === 'has-example') {
    return { requireProse: true, requireExample: true };
  }
  if (currentState === 'prose-only') {
    return { requireProse: true, requireExample: false };
  }
  return { fail: 'currentState=no-jsdoc (unclassified entry, expected to fail)' };
}

function checkItem(
  item: PopulationItem,
  pkg: PkgJson,
  programCache: Map<
    string,
    { program: ts.Program; checker: ts.TypeChecker; sourceFile: ts.SourceFile }
  >,
  sourceCache: Map<
    string,
    { program: ts.Program; checker: ts.TypeChecker; sourceFile: ts.SourceFile }
  >,
  compilerOptions: ts.CompilerOptions,
): string | null {
  const result = resolveTriple(item.triple, pkg, programCache);
  if (!result.state) return `  ${item.triple}: ${result.reason ?? 'resolution failed'}`;
  // Only re-derive currentState if the assertion rule needs it.
  const currentState =
    item.classification === 'unclassified'
      ? detectCurrentStateFromSource(
          item.sourceFile,
          item.sourceName,
          item.kind,
          sourceCache,
          compilerOptions,
        )
      : 'no-jsdoc';
  const rule = pickAssertionRule(item, currentState);
  if ('fail' in rule) return `  ${item.triple}: ${rule.fail}`;
  const errors: string[] = [];
  if (rule.requireProse && !result.state.hasProse) {
    errors.push(`  ${item.triple}: missing prose description in emitted declaration`);
  }
  if (rule.requireExample && !result.state.hasExample) {
    errors.push(`  ${item.triple}: missing @example tag in emitted declaration`);
  }
  return errors.length > 0 ? errors.join('\n') : null;
}

function main(): void {
  const selector = parseArgs(process.argv.slice(2));
  const manifest: Manifest = buildManifest();
  const pkg = loadPackageJson();
  const compilerOptions = loadCompilerOptions();

  // Pre-flight: every entry-point's emitted .d.ts must exist before we walk
  // any tuple — otherwise we'd flood the user with hundreds of identical
  // "declaration file not found" errors. Bail with one summary line.
  const missingDts: string[] = [];
  for (const importPath of Object.keys(manifest.publicEntryPoints)) {
    try {
      const dtsPath = declarationFileFor(importPath, pkg);
      if (!existsSync(dtsPath)) missingDts.push(`  - ${importPath} → ${dtsPath}`);
    } catch (err) {
      missingDts.push(`  - ${importPath}: ${(err as Error).message}`);
    }
  }
  if (missingDts.length > 0) {
    console.error(
      `check-declaration-jsdoc: ${missingDts.length} declaration file(s) missing — run \`bun run build\` first.`,
    );
    for (const line of missingDts) console.error(line);
    process.exit(1);
  }

  const population = buildPopulation(selector, manifest);
  const programCache = new Map<
    string,
    { program: ts.Program; checker: ts.TypeChecker; sourceFile: ts.SourceFile }
  >();
  const sourceCache = new Map<
    string,
    { program: ts.Program; checker: ts.TypeChecker; sourceFile: ts.SourceFile }
  >();
  const failures: string[] = [];
  for (const item of population) {
    const failure = checkItem(item, pkg, programCache, sourceCache, compilerOptions);
    if (failure) failures.push(failure);
  }
  if (failures.length > 0) {
    console.error('check-declaration-jsdoc: failures:');
    for (const line of failures) console.error(line);
    console.error(
      '  → Fix: each failing triple needs prose JSDoc and (for example-required entries) at least one @example block in the source declaration. Edit the source file, then re-run `bun run build && bun run scripts/check-declaration-jsdoc.ts --all`.',
    );
    process.exit(1);
  }
  console.log(`check-declaration-jsdoc: ${population.length} triples passed`);
}

main();

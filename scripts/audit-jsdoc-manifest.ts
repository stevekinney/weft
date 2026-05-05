/**
 * Independent verification that the in-memory manifest's public-surface set
 * agrees with what consumers actually see (the emitted .d.ts files), and that
 * every classified entry's currentState satisfies the example-required /
 * prose-only invariants.
 *
 * The audit deliberately uses a different enumeration mechanism than
 * scripts/lib/jsdoc-manifest.ts (which walks source) so a shared logic bug
 * cannot make both gates agree on a wrong denominator. The audit walks the
 * emitted dist/<path>.d.ts files via ts.createProgram + getExportsOfModule.
 *
 * The audit asserts:
 *   1. publicEntryPoints recomputed from package.json `exports` matches the
 *      manifest's stored table (key set + source-file targets).
 *   2. For each public specifier, the (importPath, exportName, kind) triples
 *      derived by walking the emitted .d.ts equal the manifest's publicFaces
 *      union for that specifier.
 *   3. For each manifest entry with classification == 'example-required',
 *      the re-derived currentState (read from source JSDoc) is 'has-example'.
 *   4. For each manifest entry with classification == 'prose-only', the
 *      re-derived currentState is 'prose-only' or 'has-example'.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

import { buildManifest, type ManifestEntry, type SymbolKind } from './lib/jsdoc-manifest.ts';

const REPO_ROOT = resolve(import.meta.dir, '..');
const PACKAGE_JSON = resolve(REPO_ROOT, 'package.json');

type CurrentState = 'no-jsdoc' | 'prose-only' | 'has-example';

// ---------------------------------------------------------------------------
// package.json reading.
//
// `pickTypesField` and `distToSource` below are intentionally duplicated from
// scripts/lib/jsdoc-manifest.ts. The audit's whole point is to be an
// independent cross-check: if both the manifest builder and the audit shared
// these helpers, a logic bug in one place would silently make both gates
// agree on the wrong answer. Edit either file with that in mind — they
// should stay byte-for-byte equivalent in behavior, but a refactor that
// merges them into a single shared helper defeats the cross-check.
// ---------------------------------------------------------------------------

type PkgJson = { name: string; exports?: Record<string, unknown> };

function loadPackageJson(): PkgJson {
  return JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
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

function distToSource(distRelative: string): string {
  return distRelative
    .replace(/^\.\//, '')
    .replace(/^dist\//, 'src/')
    .replace(/\.d\.ts$/, '.ts');
}

function recomputePublicEntryPoints(pkg: PkgJson): Record<string, string> {
  if (!pkg.exports) throw new Error('package.json missing `exports` map');
  const out: Record<string, string> = {};
  for (const [subpath, value] of Object.entries(pkg.exports)) {
    const typesPath = pickTypesField(value);
    if (!typesPath) continue;
    const sourcePath = distToSource(typesPath);
    const importPath = subpath === '.' ? pkg.name : `${pkg.name}/${subpath.replace(/^\.\//, '')}`;
    out[importPath] = sourcePath;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Conditional-types coverage check.
//
// `pickTypesField` returns null for a conditional shape that has nested
// platform `types` (e.g. `{ bun: { types }, node: { types } }`) without a
// top-level `types` field. Both the manifest builder and the audit silently
// skip these — the contract is that explicit per-platform subpaths
// (`./storage/sqlite/bun`, `./storage/sqlite/node`) cover the public surface
// instead. This check makes that contract enforceable.
//
// Two condition shapes need different treatment:
//   - Platform conditions (`bun`, `node`) name a runtime; `${subpath}/${name}`
//     is a meaningful explicit subpath the project already uses.
//   - Module-shape conditions (`import`, `default`) do not name a platform;
//     `${subpath}/import` would be nonsense as a public import path. For
//     these, the only correct fix is to hoist a unified top-level `types`
//     field on the subpath itself.
// ---------------------------------------------------------------------------

const PLATFORM_KEYS = ['bun', 'node'] as const;
const MODULE_SHAPE_KEYS = ['import', 'default'] as const;
type ConditionKey = (typeof PLATFORM_KEYS)[number] | (typeof MODULE_SHAPE_KEYS)[number];

type ConditionalOnlyExport = {
  subpath: string;
  platformKeys: (typeof PLATFORM_KEYS)[number][];
  moduleShapeKeys: (typeof MODULE_SHAPE_KEYS)[number][];
};

function findConditionalOnlyExports(pkg: PkgJson): ConditionalOnlyExport[] {
  if (!pkg.exports) return [];
  const out: ConditionalOnlyExport[] = [];
  for (const [subpath, value] of Object.entries(pkg.exports)) {
    if (typeof value !== 'object' || value === null) continue;
    const obj = value as Record<string, unknown>;
    if (typeof obj['types'] === 'string') continue;
    const platformKeys: (typeof PLATFORM_KEYS)[number][] = [];
    const moduleShapeKeys: (typeof MODULE_SHAPE_KEYS)[number][] = [];
    for (const key of [...PLATFORM_KEYS, ...MODULE_SHAPE_KEYS] as ConditionKey[]) {
      const inner = obj[key];
      if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
        const innerTypes = (inner as Record<string, unknown>)['types'];
        if (typeof innerTypes === 'string') {
          if ((PLATFORM_KEYS as readonly string[]).includes(key)) {
            platformKeys.push(key as (typeof PLATFORM_KEYS)[number]);
          } else {
            moduleShapeKeys.push(key as (typeof MODULE_SHAPE_KEYS)[number]);
          }
        }
      }
    }
    if (platformKeys.length > 0 || moduleShapeKeys.length > 0) {
      out.push({ subpath, platformKeys, moduleShapeKeys });
    }
  }
  return out;
}

function assertConditionalSubpathCoverage(pkg: PkgJson, failures: string[]): void {
  const conditionalExports = findConditionalOnlyExports(pkg);
  for (const { subpath, platformKeys, moduleShapeKeys } of conditionalExports) {
    // Platform conditions: require an explicit `${subpath}/${platform}`
    // subpath whose own export entry has a usable top-level types field.
    // The key existing isn't enough — a string-only export, or an export
    // without a top-level types field, would silently re-create the same
    // coverage gap this check exists to close.
    for (const platform of platformKeys) {
      const expectedSubpath = `${subpath}/${platform}`;
      const subpathValue = pkg.exports?.[expectedSubpath];
      if (subpathValue === undefined) {
        failures.push(
          `  conditional-types coverage: \`${subpath}\` has nested \`${platform}.types\` but no explicit \`${expectedSubpath}\` subpath. Either add the explicit subpath or hoist a unified \`types\` field on \`${subpath}\`.`,
        );
        continue;
      }
      if (pickTypesField(subpathValue) === null) {
        failures.push(
          `  conditional-types coverage: \`${expectedSubpath}\` exists but has no usable top-level \`types\` field. Add \`types\` to that export or hoist a unified \`types\` field on \`${subpath}\`.`,
        );
      }
    }
    // Module-shape conditions (`import`, `default`): the only correct fix is
    // a top-level unified `types` field on the subpath itself.
    for (const conditionKey of moduleShapeKeys) {
      failures.push(
        `  conditional-types coverage: \`${subpath}\` has nested \`${conditionKey}.types\` but no top-level \`types\` field. Hoist a unified \`types\` field on \`${subpath}\` (\`import\`/\`default\` are not platform names — they cannot be covered by an explicit per-platform subpath).`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Resolve a public specifier to its emitted .d.ts file.
// ---------------------------------------------------------------------------

function declarationFileFor(importPath: string, pkg: PkgJson): string {
  if (!pkg.exports) throw new Error('package.json missing `exports` map');
  const key = importPath === pkg.name ? '.' : `./${importPath.slice(pkg.name.length + 1)}`;
  const value = pkg.exports[key];
  if (value === undefined) throw new Error(`No exports entry for key ${key}`);
  const typesPath = pickTypesField(value);
  if (!typesPath) throw new Error(`exports[${key}] has no .types field`);
  return resolve(REPO_ROOT, typesPath.replace(/^\.\//, ''));
}

// ---------------------------------------------------------------------------
// Symbol kind inference (resolves aliases first).
// ---------------------------------------------------------------------------

function resolvedKind(symbol: ts.Symbol, checker: ts.TypeChecker): SymbolKind | null {
  let underlying = symbol;
  while (underlying.flags & ts.SymbolFlags.Alias) {
    const next = checker.getAliasedSymbol(underlying);
    if (!next || next === underlying) break;
    underlying = next;
  }
  const f = underlying.flags;
  if (f & (ts.SymbolFlags.Module | ts.SymbolFlags.Namespace)) return 'namespace';
  if (
    f &
    (ts.SymbolFlags.Class |
      ts.SymbolFlags.Function |
      ts.SymbolFlags.Variable |
      ts.SymbolFlags.Enum |
      ts.SymbolFlags.EnumMember |
      ts.SymbolFlags.ConstEnum)
  ) {
    return 'value';
  }
  if (f & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias | ts.SymbolFlags.TypeParameter)) {
    return 'type';
  }
  if (f & ts.SymbolFlags.Value) return 'value';
  if (f & ts.SymbolFlags.Type) return 'type';
  return null;
}

// ---------------------------------------------------------------------------
// Walk emitted .d.ts files and collect (importPath, exportName, kind) triples.
// ---------------------------------------------------------------------------

function collectFromDeclarations(
  publicEntryPoints: Record<string, string>,
  pkg: PkgJson,
): { triples: Set<string>; missingFiles: string[] } {
  const dtsFiles: string[] = [];
  for (const importPath of Object.keys(publicEntryPoints)) {
    const file = declarationFileFor(importPath, pkg);
    if (!existsSync(file)) {
      return { triples: new Set(), missingFiles: [file] };
    }
    dtsFiles.push(file);
  }

  const program = ts.createProgram(dtsFiles, {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    skipLibCheck: true,
    allowJs: false,
  });
  const checker = program.getTypeChecker();
  const triples = new Set<string>();

  for (const importPath of Object.keys(publicEntryPoints)) {
    const file = declarationFileFor(importPath, pkg);
    const sourceFile = program.getSourceFile(file);
    if (!sourceFile) continue;
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) continue;
    const exports = checker.getExportsOfModule(moduleSymbol);
    for (const exp of exports) {
      const exportName = exp.getName();
      const kind = resolvedKind(exp, checker);
      if (!kind) continue;
      triples.add(`${importPath}#${exportName}#${kind}`);
    }
  }
  return { triples, missingFiles: [] };
}

// ---------------------------------------------------------------------------
// Re-derive currentState from a source declaration's JSDoc.
// ---------------------------------------------------------------------------

function detectCurrentStateFromSource(
  entry: ManifestEntry,
  sourceFileCache: Map<string, ts.SourceFile>,
): CurrentState {
  const absolute = resolve(REPO_ROOT, entry.sourceFile);
  let sourceFile = sourceFileCache.get(absolute);
  if (!sourceFile) {
    if (!existsSync(absolute)) return 'no-jsdoc';
    const text = readFileSync(absolute, 'utf8');
    sourceFile = ts.createSourceFile(absolute, text, ts.ScriptTarget.Latest, true);
    sourceFileCache.set(absolute, sourceFile);
  }
  let result: CurrentState = 'no-jsdoc';
  function nameMatches(node: ts.NamedDeclaration): boolean {
    const name = node.name;
    if (!name) return false;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text === entry.sourceName;
    return false;
  }
  function visit(node: ts.Node): void {
    if (
      (ts.isClassDeclaration(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isModuleDeclaration(node)) &&
      nameMatches(node)
    ) {
      const state = inspectJSDoc(node);
      if (state === 'has-example') result = 'has-example';
      else if (state === 'prose-only' && result !== 'has-example') result = 'prose-only';
    }
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === entry.sourceName) {
          const state = inspectJSDoc(node);
          if (state === 'has-example') result = 'has-example';
          else if (state === 'prose-only' && result !== 'has-example') result = 'prose-only';
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return result;
}

function inspectJSDoc(node: ts.Node): CurrentState {
  const tags = ts.getJSDocTags(node);
  const hasExample = tags.some((t) => t.tagName.text === 'example');
  let proseText = '';
  for (const c of ts.getJSDocCommentsAndTags(node)) {
    if (ts.isJSDoc(c)) {
      const comment = c.comment;
      if (typeof comment === 'string') proseText += comment;
      else if (Array.isArray(comment)) {
        for (const part of comment) {
          if (part.kind === ts.SyntaxKind.JSDocText) proseText += part.text;
        }
      }
    }
  }
  const hasProse = proseText.trim().length > 0;
  if (hasProse && hasExample) return 'has-example';
  if (hasProse) return 'prose-only';
  return 'no-jsdoc';
}

// ---------------------------------------------------------------------------
// Assertions.
// ---------------------------------------------------------------------------

function assertEqualMaps(
  label: string,
  a: Record<string, string>,
  b: Record<string, string>,
  failures: string[],
): void {
  const aKeys = Object.keys(a).toSorted();
  const bKeys = Object.keys(b).toSorted();
  for (const key of new Set([...aKeys, ...bKeys])) {
    if (!(key in a))
      failures.push(`  ${label}: key '${key}' present in manifest but not recomputed`);
    else if (!(key in b))
      failures.push(`  ${label}: key '${key}' recomputed but missing from manifest`);
    else if (a[key] !== b[key])
      failures.push(`  ${label}: key '${key}' = '${a[key]}' in manifest, '${b[key]}' recomputed`);
  }
}

function assertEqualSets(
  label: string,
  manifest: Set<string>,
  recomputed: Set<string>,
  failures: string[],
): void {
  for (const triple of manifest) {
    if (!recomputed.has(triple))
      failures.push(`  ${label}: ${triple} in manifest but missing from declarations`);
  }
  for (const triple of recomputed) {
    if (!manifest.has(triple))
      failures.push(`  ${label}: ${triple} in declarations but missing from manifest`);
  }
}

// ---------------------------------------------------------------------------
// Main entry point.
// ---------------------------------------------------------------------------

function main(): void {
  const manifest = buildManifest();
  const pkg = loadPackageJson();

  const unclassified = manifest.entries.filter((e) => e.classification === 'unclassified');
  if (unclassified.length > 0) {
    console.error(
      `audit-jsdoc-manifest: in-memory manifest contains ${unclassified.length} unclassified entries; classification logic in scripts/lib/jsdoc-manifest.ts is broken`,
    );
    process.exit(1);
  }

  const failures: string[] = [];

  // Assertion 1: publicEntryPoints.
  const recomputedPEP = recomputePublicEntryPoints(pkg);
  assertEqualMaps('publicEntryPoints', manifest.publicEntryPoints, recomputedPEP, failures);

  // Assertion 1b: conditional-only-types subpath coverage.
  assertConditionalSubpathCoverage(pkg, failures);

  // Assertion 2: declaration-derived public-face set vs manifest publicFaces.
  const { triples: declTriples, missingFiles } = collectFromDeclarations(recomputedPEP, pkg);
  if (missingFiles.length > 0) {
    console.error(
      `audit-jsdoc-manifest: declaration files missing (run \`bun run build\` first):\n  ${missingFiles.join('\n  ')}`,
    );
    process.exit(1);
  }
  const manifestTriples = new Set<string>();
  for (const entry of manifest.entries) {
    if (entry.classification === 'not-public') continue;
    for (const face of entry.publicFaces) {
      manifestTriples.add(`${face.importPath}#${face.exportName}#${face.kind}`);
    }
  }
  assertEqualSets('public-face set', manifestTriples, declTriples, failures);

  // Assertion 3 & 4: classification invariants.
  const sourceFileCache = new Map<string, ts.SourceFile>();
  for (const entry of manifest.entries) {
    if (entry.classification === 'not-public') continue;
    const rederived = detectCurrentStateFromSource(entry, sourceFileCache);
    if (entry.classification === 'example-required' && rederived !== 'has-example') {
      failures.push(
        `  example-required entry has currentState=${rederived}: ${entry.sourceFile}#${entry.sourceName}#${entry.kind}`,
      );
    } else if (entry.classification === 'prose-only' && rederived === 'no-jsdoc') {
      failures.push(
        `  prose-only entry has currentState=no-jsdoc: ${entry.sourceFile}#${entry.sourceName}#${entry.kind}`,
      );
    }
  }

  if (failures.length > 0) {
    console.error('audit-jsdoc-manifest: failures:');
    for (const line of failures) console.error(line);
    console.error(
      [
        '',
        'How to fix:',
        '  - "publicEntryPoints: key X present/missing": package.json `exports` and the build are out of sync.',
        '    Run `bun run build` to regenerate dist/.',
        '  - "public-face set: X in manifest but missing from declarations": a public export was',
        '    removed from the runtime surface but still appears in source. Run `bun run build` first.',
        '  - "public-face set: X in declarations but missing from manifest": a NEW public export',
        '    was added — the in-memory builder should pick it up automatically. If this fires,',
        '    inspect scripts/lib/jsdoc-manifest.ts (the source walker may not be reaching the symbol).',
        '  - "example-required entry has currentState=...": JSDoc is missing or incomplete on the',
        "    source declaration. Add prose + an @example block (`import { X } from '<face>'` first),",
        '    then re-run.',
        '  - "prose-only entry has currentState=no-jsdoc": source prose is missing.',
        '    Add descriptive JSDoc prose to the source declaration, then re-run the audit.',
      ].join('\n'),
    );
    process.exit(1);
  }
  console.log(
    `audit-jsdoc-manifest: ok (${Object.keys(recomputedPEP).length} entry points, ${manifestTriples.size} public-face triples)`,
  );
}

main();

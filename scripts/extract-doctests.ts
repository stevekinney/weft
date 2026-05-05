/**
 * Extracts every @example block from manifest entries and writes one .ts file
 * per block to tmp/doctests/<batchSlug>/<importPath-slug>__<exportName>__<kind>__<index>.ts.
 * Generates tmp/doctests/tsconfig.json with `paths` resolved from the manifest's
 * publicEntryPoints table so 'weft' and subpaths resolve to source files.
 *
 * The extractor is NOT a coverage tool — it only produces compileable artifacts.
 * Coverage enforcement is audit-jsdoc-manifest.ts's job.
 *
 * Hard requirement on examples: each block must contain at least one
 *   import ... from 'weft'   |   import type ... from 'weft'   |   mixed
 * statement as one of its first non-blank lines. Blocks missing this are
 * reported and the run aborts with a non-zero exit (no silent injection).
 *
 * Usage: bun run scripts/extract-doctests.ts
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

import { buildManifest, type PublicFace } from './lib/jsdoc-manifest.ts';

const REPO_ROOT = resolve(import.meta.dir, '..');
const DOCTESTS_DIR = resolve(REPO_ROOT, 'tmp/doctests');

// ---------------------------------------------------------------------------
// Slugification helpers — keep filenames safe across filesystems.
// ---------------------------------------------------------------------------

function slugify(input: string): string {
  return input.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Short, deterministic, case-sensitive digest used to disambiguate filenames
// for symbols whose names differ only in casing (e.g. `ScopedStorage` vs
// `scopedStorage`). Encodes which characters were originally uppercase as a
// short bit-packed hex string. Stable across runs for any given input.
function caseDigest(input: string): string {
  let bits = 0n;
  for (let i = 0; i < input.length; i += 1) {
    const c = input.charCodeAt(i);
    if (c >= 65 && c <= 90) bits |= 1n << BigInt(i);
  }
  // 8 hex chars = 32 bits = first 32 characters covered. Beyond that we just
  // truncate; collisions among ≥32-character names with identical case patterns
  // beyond char 32 are accepted (essentially impossible in practice).
  return (bits & 0xffffffffn).toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Extract @example blocks from a source declaration. Returns the raw block
// content with the surrounding ```ts ... ``` fence stripped, plus any blocks
// that have a non-ts fence so the caller can warn about them — silently
// skipping a `typescript`/`javascript` fence would let real examples bypass
// the doctest gate.
// ---------------------------------------------------------------------------

type ExtractedExamples = {
  examples: string[];
  badFences: { language: string; preview: string }[]; // non-ts fences (must be ts)
  fenceless: boolean[]; // @example tags with no fenced code block at all
};

function extractExamples(sourceFile: ts.SourceFile, sourceName: string): ExtractedExamples {
  const examples: string[] = [];
  const badFences: { language: string; preview: string }[] = [];
  const fenceless: boolean[] = [];
  function visit(node: ts.Node): void {
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isVariableStatement(node)) &&
      hasMatchingName(node, sourceName)
    ) {
      const tags = ts.getJSDocTags(node);
      for (const tag of tags) {
        if (tag.tagName.text === 'example') {
          const text = readJSDocComment(tag.comment);
          // Match ```ts (optional language meta) \n (block content) \n ```
          const tsFence = text.match(/```ts\b[^\n]*\n([\s\S]*?)```/);
          if (tsFence) {
            examples.push(tsFence[1]);
            continue;
          }
          // Non-ts fence — flag for warning; silently skipping would let real
          // examples bypass the doctest gate.
          const anyFence = text.match(/```([^\s`]*)[^\n]*\n([\s\S]*?)```/);
          if (anyFence) {
            badFences.push({
              language: anyFence[1] || '(empty)',
              preview: anyFence[2].slice(0, 80).replace(/\n/g, ' '),
            });
            continue;
          }
          fenceless.push(true);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return { examples, badFences, fenceless };
}

function hasMatchingName(node: ts.Node, sourceName: string): boolean {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node)
  ) {
    const name = node.name;
    if (!name) return false;
    if (ts.isIdentifier(name)) return name.text === sourceName;
    return name.getText() === sourceName;
  }
  if (ts.isVariableStatement(node)) {
    for (const decl of node.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === sourceName) return true;
    }
  }
  return false;
}

function readJSDocComment(comment: ts.JSDocTag['comment']): string {
  if (typeof comment === 'string') return comment;
  if (!comment) return '';
  let out = '';
  for (const part of comment) {
    if (part.kind === ts.SyntaxKind.JSDocText) {
      out += part.text;
    } else if ('text' in part && typeof part.text === 'string') {
      out += part.text;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Validate that an example block imports the documented export from at least
// one of the symbol's publicFaces import paths. Accepts value, type-only, or
// mixed import forms, including aliases.
//
// For a symbol reachable only from one path (e.g. `weft/storage/lmdb#LMDBStorage`),
// the example MUST import from that path — importing from `'weft'` would be
// misleading because `LMDBStorage` isn't re-exported there. For symbols
// reachable from multiple paths (e.g. `MemoryStorage` is at both `'weft'` and
// `'weft/storage/memory'`), importing from any one valid face is acceptable.
// ---------------------------------------------------------------------------

function hasFaceImport(block: string, publicFaces: PublicFace[]): boolean {
  const sourceFile = ts.createSourceFile('doctest.ts', block, ts.ScriptTarget.Latest, true);
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const importPath = statement.moduleSpecifier.text;
    const matchingFaces = publicFaces.filter((face) => face.importPath === importPath);
    if (matchingFaces.length === 0) continue;
    const importClause = statement.importClause;
    if (!importClause) continue;
    for (const face of matchingFaces) {
      if (importClause.name?.text === face.exportName) return true;
      const namedBindings = importClause.namedBindings;
      if (!namedBindings) continue;
      if (ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) {
          const importedName = element.propertyName?.text ?? element.name.text;
          if (importedName === face.exportName) return true;
        }
      } else {
        const namespaceName = namedBindings.name.text;
        const namespaceAccess = new RegExp(`\\b${namespaceName}\\.${face.exportName}\\b`);
        if (namespaceAccess.test(block)) return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Build tmp/doctests/tsconfig.json with `paths` from publicEntryPoints.
// ---------------------------------------------------------------------------

function writeTsconfig(publicEntryPoints: Record<string, string>): void {
  const paths: Record<string, string[]> = {};
  for (const [importPath, sourceRel] of Object.entries(publicEntryPoints)) {
    // tsconfig paths are relative to baseUrl. tmp/doctests/ sits two levels
    // under REPO_ROOT, so paths are written relative to that.
    paths[importPath] = [`../../${sourceRel.replace(/\.ts$/, '')}`];
  }
  // Extend the project tsconfig to inherit lib/target/strictness rules so
  // doctests compile against the same ground truth as project sources. We
  // override `include`, `paths`, `noUnusedLocals`, and `noUnusedParameters`
  // because doctests are minimal snippets that often declare unused locals.
  const tsconfig = {
    extends: '../../tsconfig.json',
    compilerOptions: {
      noEmit: true,
      noUnusedLocals: false,
      noUnusedParameters: false,
      baseUrl: '.',
      paths,
    },
    include: ['./**/*.ts'],
    exclude: [],
  };
  writeFileSync(
    resolve(DOCTESTS_DIR, 'tsconfig.json'),
    JSON.stringify(tsconfig, null, 2) + '\n',
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

function main(): void {
  const manifest = buildManifest();

  // Reset the doctests directory.
  if (existsSync(DOCTESTS_DIR)) rmSync(DOCTESTS_DIR, { recursive: true, force: true });
  mkdirSync(DOCTESTS_DIR, { recursive: true });

  // Cache parsed source files.
  const sourceCache = new Map<string, ts.SourceFile>();
  function getSource(sourceRel: string): ts.SourceFile | null {
    let cached = sourceCache.get(sourceRel);
    if (cached) return cached;
    const absolute = resolve(REPO_ROOT, sourceRel);
    if (!existsSync(absolute)) return null;
    const text = readFileSync(absolute, 'utf8');
    cached = ts.createSourceFile(absolute, text, ts.ScriptTarget.Latest, true);
    sourceCache.set(sourceRel, cached);
    return cached;
  }

  let totalBlocks = 0;
  const missingImports: string[] = [];
  const malformedFences: string[] = [];

  // Iterate manifest entries; only entries reachable from a public face produce
  // doctests (we want consumer-visible imports to be the source of truth, and
  // not-public entries don't have a public import path to write into the block).
  for (const entry of manifest.entries) {
    if (entry.publicFaces.length === 0) continue;
    const sourceFile = getSource(entry.sourceFile);
    if (!sourceFile) continue;
    const { examples, badFences, fenceless } = extractExamples(sourceFile, entry.sourceName);
    for (const bad of badFences) {
      const fenceMarker = '```';
      malformedFences.push(
        `  ${entry.sourceFile}#${entry.sourceName}: @example uses ${fenceMarker}${bad.language} fence (must be ${fenceMarker}ts) — preview: "${bad.preview}"`,
      );
    }
    for (let i = 0; i < fenceless.length; i++) {
      malformedFences.push(
        `  ${entry.sourceFile}#${entry.sourceName}: @example tag #${i + 1} has no fenced code block`,
      );
    }
    if (examples.length === 0) continue;
    const batchSlug =
      entry.classification === 'unclassified' ? 'unclassified' : entry.classification;
    const batchDir = resolve(DOCTESTS_DIR, slugify(batchSlug));
    mkdirSync(batchDir, { recursive: true });

    // The example must import from at least one of the entry's publicFaces.
    // For multi-face symbols (re-exported from both `'weft'` and a subpath),
    // any one valid face import is acceptable for all faces.
    examples.forEach((block, index) => {
      if (!hasFaceImport(block, entry.publicFaces)) {
        const facesList = entry.publicFaces
          .map((f) => `${f.importPath}#${f.exportName}#${f.kind}`)
          .join(', ');
        missingImports.push(
          `  ${entry.sourceFile}#${entry.sourceName} (example ${index + 1}): no import of a documented public export from one of its public faces; faces=[${facesList}]`,
        );
        return;
      }
      // Emit one doctest file per face — same source block, different filename
      // so the per-face declaration check has a per-face artifact to point at.
      // Filenames are lowercased and disambiguated with a short case-tag because
      // case-insensitive filesystems (macOS default) collapse e.g. `ScopedStorage`
      // and `scopedStorage` into the same path, AND TypeScript's
      // `forceConsistentCasingInFileNames` rejects mixed-case duplicates on
      // case-sensitive filesystems (Linux CI). The case-tag is a short hex digest
      // of the original-cased exportName, so two exports that differ only in
      // case still produce distinct filenames everywhere.
      for (const face of entry.publicFaces) {
        const caseTag = caseDigest(face.exportName);
        const filename = `${slugify(face.importPath)}__${slugify(face.exportName).toLowerCase()}-${caseTag}__${face.kind}__${index}.ts`;
        const filePath = resolve(batchDir, filename);
        const wrapped = `// auto-generated from @example block of ${face.importPath}#${face.exportName}#${face.kind}\n${block}\n`;
        writeFileSync(filePath, wrapped, 'utf8');
        totalBlocks++;
      }
    });
  }

  writeTsconfig(manifest.publicEntryPoints);

  if (malformedFences.length > 0) {
    console.error('extract-doctests: malformed @example fences (must be ```ts):');
    for (const line of malformedFences) console.error(line);
    console.error(
      '  → Fix: edit the source @example block to use the ```ts language tag (no `typescript`, no untagged fences). The doctest gate only compiles ```ts blocks, so other tags would silently bypass type-checking.',
    );
    process.exit(1);
  }

  if (missingImports.length > 0) {
    console.error("extract-doctests: examples missing required `from '<publicFace>'` import:");
    for (const line of missingImports) console.error(line);
    console.error(
      "  → Fix: each @example block must import its symbol from the same path the consumer would. For an entry whose publicFaces[0].importPath is 'weft/storage/lmdb', the example must include `import { ... } from 'weft/storage/lmdb';` (related auxiliary imports from 'weft' are fine in addition).",
    );
    process.exit(1);
  }

  console.log(`Wrote ${totalBlocks} doctest files under ${DOCTESTS_DIR}`);
  console.log(`Wrote ${resolve(DOCTESTS_DIR, 'tsconfig.json')}`);
}

main();

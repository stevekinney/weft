/** Extracts fixture declarations and writes their manifest. */
export { extractFixtures, writeFixtureManifest } from './extractor.ts';
/** Loads fixture files and resolves their component and host paths. */
export { loadFixtureFile, resolveFixtureFilePath, resolveFixtureHostPath } from './loader.ts';
/** Parses fixture declarations without executing their source module. */
export { parseFixtureFileStatic } from './parser.ts';
export type { FileParseResult, FixtureExtractResult, FixtureFileEntry } from './types.ts';

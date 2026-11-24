import type { VisualFixture, VisualFixtureMetadata } from '../visual-fixtures.ts';

/** Parsed fixtures and metadata from one source file. */
export type FixtureFileEntry = {
  /** Component name declared by the file. */
  componentName: string;
  /** Absolute source path. */
  sourcePath: string;
  /** SHA-256 hash of the source contents. */
  contentHash: string;
  /** Parsed visual fixtures. */
  fixtures: VisualFixture[];
  /** Parsed fixture metadata. */
  metadata: VisualFixtureMetadata;
};

/** Result of extracting all fixture files. */
export type FixtureExtractResult = {
  /** Successfully parsed entries. */
  entries: FixtureFileEntry[];
  /** Validation violations collected during extraction. */
  violations: string[];
};

/** Result of parsing one fixture source file. */
export type FileParseResult =
  | { kind: 'entry'; entry: FixtureFileEntry }
  | { kind: 'violations'; violations: string[] }
  | { kind: 'skipped' };

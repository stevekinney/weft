import { mkdirSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

export type DoctestPublicEntryPoints = Record<string, string>;

export type DoctestTsconfigOptions = {
  repositoryRoot: string;
  doctestsDirectory: string;
  publicEntryPoints: DoctestPublicEntryPoints;
};

export type DoctestTsconfig = {
  extends: string;
  compilerOptions: {
    noEmit: true;
    noUnusedLocals: false;
    noUnusedParameters: false;
    baseUrl: '.';
    paths: Record<string, string[]>;
  };
  include: ['./**/*.ts'];
  exclude: [];
};

export function createDoctestTsconfig(options: DoctestTsconfigOptions): DoctestTsconfig {
  const repositoryRoot = resolve(options.repositoryRoot);
  const doctestsDirectory = resolve(options.doctestsDirectory);
  const paths: Record<string, string[]> = {};
  for (const [importPath, sourceRel] of Object.entries(options.publicEntryPoints)) {
    const sourcePath = resolve(
      repositoryRoot,
      validateDoctestSourcePath(importPath, repositoryRoot, sourceRel),
    );
    paths[importPath] = [withoutTypeScriptExtension(toTsconfigPath(doctestsDirectory, sourcePath))];
  }
  return {
    extends: toTsconfigPath(doctestsDirectory, resolve(repositoryRoot, 'tsconfig.json')),
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
}

function validateDoctestSourcePath(
  importPath: string,
  repositoryRoot: string,
  sourceRel: string,
): string {
  const normalizedSourceRel = sourceRel.replaceAll('\\', '/');
  const pathSegments = normalizedSourceRel.split('/');
  const sourcePath = resolve(repositoryRoot, normalizedSourceRel);
  const repositoryRelativePath = relative(repositoryRoot, sourcePath);
  if (
    normalizedSourceRel.startsWith('/') ||
    pathSegments.includes('..') ||
    !normalizedSourceRel.endsWith('.ts') ||
    repositoryRelativePath.startsWith('../') ||
    repositoryRelativePath === '..' ||
    repositoryRelativePath.includes(':')
  ) {
    throw new Error(
      `Invalid doctest source path for ${importPath}: expected a repository-relative TypeScript path, received ${sourceRel}`,
    );
  }
  return normalizedSourceRel;
}

function toTsconfigPath(fromDirectory: string, toPath: string): string {
  return relative(fromDirectory, toPath).replaceAll('\\', '/');
}

function withoutTypeScriptExtension(filePath: string): string {
  return filePath.replace(/\.ts$/, '');
}

export function formatDoctestTsconfig(options: DoctestTsconfigOptions): string {
  return `${JSON.stringify(createDoctestTsconfig(options), null, 2)}\n`;
}

export function writeDoctestTsconfig(options: DoctestTsconfigOptions): void {
  const doctestsDirectory = resolve(options.doctestsDirectory);
  mkdirSync(doctestsDirectory, { recursive: true });
  writeFileSync(
    resolve(doctestsDirectory, 'tsconfig.json'),
    formatDoctestTsconfig(options),
    'utf8',
  );
}

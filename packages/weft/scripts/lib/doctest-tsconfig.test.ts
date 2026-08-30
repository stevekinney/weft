import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import {
  createDoctestTsconfig,
  formatDoctestTsconfig,
  writeDoctestTsconfig,
} from './doctest-tsconfig.ts';

describe('doctest tsconfig generation', () => {
  const publicEntryPoints = {
    '@lostgradient/weft': 'src/index.ts',
    '@lostgradient/weft/storage/memory': 'src/storage/memory.ts',
  };
  const repositoryRoot = '/workspace/weft';
  const doctestsDirectory = '/workspace/weft/tmp/doctests';

  const expectedTsconfig = {
    extends: '../../tsconfig.json',
    compilerOptions: {
      noEmit: true,
      noUnusedLocals: false,
      noUnusedParameters: false,
      baseUrl: '.',
      paths: {
        '@lostgradient/weft': ['../../src/index'],
        '@lostgradient/weft/storage/memory': ['../../src/storage/memory'],
      },
    },
    include: ['./**/*.ts'],
    exclude: [],
  };

  it('creates the shared doctest tsconfig shape', () => {
    expect(
      createDoctestTsconfig({
        repositoryRoot,
        doctestsDirectory,
        publicEntryPoints,
      }),
    ).toEqual(expectedTsconfig);
  });

  it('creates paths relative to the doctest directory', () => {
    expect(
      createDoctestTsconfig({
        repositoryRoot,
        doctestsDirectory: '/workspace/weft/generated/nested/doctests',
        publicEntryPoints,
      }),
    ).toEqual({
      ...expectedTsconfig,
      extends: '../../../tsconfig.json',
      compilerOptions: {
        ...expectedTsconfig.compilerOptions,
        paths: {
          '@lostgradient/weft': ['../../../src/index'],
          '@lostgradient/weft/storage/memory': ['../../../src/storage/memory'],
        },
      },
    });
  });

  it('normalizes Windows source separators from the manifest', () => {
    expect(
      createDoctestTsconfig({
        repositoryRoot,
        doctestsDirectory,
        publicEntryPoints: {
          '@lostgradient/weft': 'src\\index.ts',
        },
      }),
    ).toEqual({
      ...expectedTsconfig,
      compilerOptions: {
        ...expectedTsconfig.compilerOptions,
        paths: {
          '@lostgradient/weft': ['../../src/index'],
        },
      },
    });
  });

  it('formats the tsconfig with one trailing newline', () => {
    const formatted = formatDoctestTsconfig({
      repositoryRoot,
      doctestsDirectory,
      publicEntryPoints,
    });

    expect(formatted).toBe(`${JSON.stringify(expectedTsconfig, null, 2)}\n`);
    expect(formatted.endsWith('\n')).toBe(true);
    expect(formatted.endsWith('\n\n')).toBe(false);
  });

  it('rejects doctest source paths outside the repository', () => {
    expect(() =>
      createDoctestTsconfig({
        repositoryRoot,
        doctestsDirectory,
        publicEntryPoints: {
          '@lostgradient/weft': '../outside.ts',
        },
      }),
    ).toThrow('Invalid doctest source path for @lostgradient/weft');
    expect(() =>
      createDoctestTsconfig({
        repositoryRoot,
        doctestsDirectory,
        publicEntryPoints: {
          '@lostgradient/weft': '/tmp/outside.ts',
        },
      }),
    ).toThrow('Invalid doctest source path for @lostgradient/weft');
    expect(() =>
      createDoctestTsconfig({
        repositoryRoot,
        doctestsDirectory,
        publicEntryPoints: {
          '@lostgradient/weft': 'src/../index.ts',
        },
      }),
    ).toThrow('Invalid doctest source path for @lostgradient/weft');
    expect(() =>
      createDoctestTsconfig({
        repositoryRoot,
        doctestsDirectory,
        publicEntryPoints: {
          '@lostgradient/weft': '..\\outside.ts',
        },
      }),
    ).toThrow('Invalid doctest source path for @lostgradient/weft');
    expect(() =>
      createDoctestTsconfig({
        repositoryRoot,
        doctestsDirectory,
        publicEntryPoints: {
          '@lostgradient/weft': 'src\\..\\index.ts',
        },
      }),
    ).toThrow('Invalid doctest source path for @lostgradient/weft');
    expect(() =>
      createDoctestTsconfig({
        repositoryRoot,
        doctestsDirectory,
        publicEntryPoints: {
          '@lostgradient/weft': 'C:\\tmp\\outside.ts',
        },
      }),
    ).toThrow('Invalid doctest source path for @lostgradient/weft');
    expect(() =>
      createDoctestTsconfig({
        repositoryRoot,
        doctestsDirectory,
        publicEntryPoints: {
          '@lostgradient/weft': 'C:/tmp/outside.ts',
        },
      }),
    ).toThrow('Invalid doctest source path for @lostgradient/weft');
  });

  it('rejects doctest source paths that are not TypeScript source files', () => {
    expect(() =>
      createDoctestTsconfig({
        repositoryRoot,
        doctestsDirectory,
        publicEntryPoints: {
          '@lostgradient/weft': 'src/index.js',
        },
      }),
    ).toThrow('Invalid doctest source path for @lostgradient/weft');
  });

  it('writes tsconfig.json into the provided doctest directory', () => {
    const directory = mkdtempSync(join(tmpdir(), 'weft-doctest-tsconfig-'));
    const testRepositoryRoot = join(directory, 'repository');
    const testDoctestsDirectory = join(testRepositoryRoot, 'tmp', 'nested', 'doctests');

    try {
      writeDoctestTsconfig({
        repositoryRoot: testRepositoryRoot,
        doctestsDirectory: testDoctestsDirectory,
        publicEntryPoints,
      });

      expect(readFileSync(join(testDoctestsDirectory, 'tsconfig.json'), 'utf8')).toBe(
        `${JSON.stringify(
          {
            ...expectedTsconfig,
            extends: '../../../tsconfig.json',
            compilerOptions: {
              ...expectedTsconfig.compilerOptions,
              paths: {
                '@lostgradient/weft': ['../../../src/index'],
                '@lostgradient/weft/storage/memory': ['../../../src/storage/memory'],
              },
            },
          },
          null,
          2,
        )}\n`,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

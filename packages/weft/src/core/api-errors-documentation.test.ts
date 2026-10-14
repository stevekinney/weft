/**
 * Drift guard for `documentation/reference/api-errors.md`. Source comments in
 * `fault-code.ts` and `weft-error.ts` cite that page as the complete FaultCode
 * mapping and WeftErrorCode table, so each table must match the source maps
 * row for row.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as root from '../index.ts';
import {
  FAULT_CODE_TO_HTTP_STATUS,
  FAULT_CODE_TO_JSON_RPC_CODE,
} from '../server/operation-fault.ts';
import { FAULT_CODE_TO_FAILURE_CATEGORY } from './fault-code.ts';
import { WeftError, isWeftErrorCode } from './weft-error.ts';

const sourceDirectory = join(import.meta.dir, '..');
const documentation = readFileSync(
  join(sourceDirectory, '..', 'documentation', 'reference', 'api-errors.md'),
  'utf8',
);

/**
 * Body rows (header excluded) of the Markdown table directly under the named
 * `##` heading, or under the named `###` subheading within it. A section ends
 * at the next heading of any level.
 */
function tableRows(heading: string, subheading?: string): string[][] {
  let start = documentation.indexOf(`\n## ${heading}\n`);
  if (start === -1) throw new Error(`api-errors.md has no "## ${heading}" section`);
  if (subheading !== undefined) {
    start = documentation.indexOf(`\n### ${subheading}\n`, start);
    if (start === -1) throw new Error(`api-errors.md has no "### ${subheading}" section`);
  }
  const next = documentation.indexOf('\n#', start + 1);
  const lines = documentation.slice(start, next === -1 ? undefined : next).split('\n');
  const isSeparator = (line: string): boolean => /^\|[\s|:-]+\|$/.test(line);
  return lines
    .filter(
      (line, index) =>
        line.startsWith('| ') && !isSeparator(line) && !isSeparator(lines[index + 1] ?? ''),
    )
    .map((line) =>
      line
        .slice(1, -1)
        .split('|')
        .map((cell) => cell.trim().replaceAll('`', '')),
    );
}

/** Keys of `publicWeftErrorCodeMap`, which `satisfies Record<WeftErrorCode, true>`. */
function publicWeftErrorCodes(): string[] {
  const source = readFileSync(join(import.meta.dir, 'weft-error.ts'), 'utf8');
  const body = /const publicWeftErrorCodeMap = \{\n([\s\S]*?)\n\} satisfies/.exec(source)?.[1];
  if (body === undefined) throw new Error('publicWeftErrorCodeMap not found in weft-error.ts');
  return [...body.matchAll(/^ {2}(\w+): true,$/gm)].map((match) => match[1] ?? '');
}

describe('documentation/reference/api-errors.md', () => {
  it('lists every FaultCode with its HTTP status, JSON-RPC code, and failure category', () => {
    const documented = tableRows('FaultCode').map(([code, status, rpc, category]) => [
      code,
      Number(status),
      Number(rpc),
      category,
    ]);
    const expected = Object.keys(FAULT_CODE_TO_FAILURE_CATEGORY).map((code) => {
      const faultCode = code as keyof typeof FAULT_CODE_TO_FAILURE_CATEGORY;
      return [
        faultCode,
        FAULT_CODE_TO_HTTP_STATUS[faultCode],
        FAULT_CODE_TO_JSON_RPC_CODE[faultCode],
        FAULT_CODE_TO_FAILURE_CATEGORY[faultCode],
      ];
    });

    const byCode = (left: readonly unknown[], right: readonly unknown[]): number =>
      String(left[0]).localeCompare(String(right[0]));
    expect(documented.toSorted(byCode)).toEqual(expected.toSorted(byCode));
  });

  it('lists every public WeftErrorCode exactly once, each in the file that defines it', () => {
    const rows = tableRows('WeftErrorCode');
    const documented = rows.map(([code = '']) => code);

    const byName = (left: string, right: string): number => left.localeCompare(right);
    expect(documented.toSorted(byName)).toEqual(publicWeftErrorCodes().toSorted(byName));
    for (const [code = '', file = ''] of rows) {
      expect(isWeftErrorCode(code)).toBe(true);
      const path = join(sourceDirectory, file);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, 'utf8')).toMatch(new RegExp(`class ${code}\\b`));
    }
  });

  it('lists exactly the root-exported WeftError classes whose codes are unregistered', () => {
    const rows = tableRows('WeftErrorCode', 'Root-exported errors without a registered code');
    const unregistered = Object.entries(root)
      .filter(
        ([name, value]) =>
          typeof value === 'function' &&
          value.prototype instanceof WeftError &&
          !isWeftErrorCode(name),
      )
      .map(([name]) => name);
    const byName = (left: string, right: string): number => left.localeCompare(right);

    expect(rows.map(([name = '']) => name).toSorted(byName)).toEqual(unregistered.toSorted(byName));
    for (const [name = '', file = ''] of rows) {
      expect(readFileSync(join(sourceDirectory, file), 'utf8')).toMatch(
        new RegExp(`class ${name}\\b`),
      );
    }
  });

  it('lists exactly the root-exported Error classes outside the WeftError family', () => {
    const rows = tableRows('WeftErrorCode', 'Root-exported errors outside the WeftError family');
    const plainErrors = Object.entries(root)
      .filter(
        ([, value]) =>
          typeof value === 'function' &&
          value !== WeftError &&
          value.prototype instanceof Error &&
          !(value.prototype instanceof WeftError),
      )
      .map(([name]) => name);
    const byName = (left: string, right: string): number => left.localeCompare(right);

    expect(rows.map(([name = '']) => name).toSorted(byName)).toEqual(plainErrors.toSorted(byName));
    for (const [name = '', file = ''] of rows) {
      expect(readFileSync(join(sourceDirectory, file), 'utf8')).toMatch(
        new RegExp(`class ${name} extends Error\\b`),
      );
    }
  });
});

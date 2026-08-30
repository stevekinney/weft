const pragmaStatementPattern = /^PRAGMA\b/iu;
const readOnlyPragmaPattern = /^PRAGMA\s+(?:[A-Z_][A-Z0-9_]*\.)?[A-Z_][A-Z0-9_]*\s*$/iu;
const selectStatementPattern = /^SELECT\b/iu;

function normalizeSql(sql: string): string {
  return sql
    .trim()
    .replace(/;+\s*$/u, '')
    .trim();
}

function isReadOnlyPragma(sql: string): boolean {
  return readOnlyPragmaPattern.test(sql);
}

/** Validate that a storage query contains exactly one read-only SELECT or bare PRAGMA statement. */
export function assertReadOnlyQuery(sql: string): void {
  const normalizedSql = normalizeSql(sql);

  if (normalizedSql.length === 0) {
    throw new Error('Storage query must not be empty.');
  }

  if (normalizedSql.includes(';')) {
    throw new Error('Storage query must contain exactly one read-only statement.');
  }

  if (selectStatementPattern.test(normalizedSql)) {
    return;
  }

  if (pragmaStatementPattern.test(normalizedSql) && isReadOnlyPragma(normalizedSql)) {
    return;
  }

  throw new Error('Storage query only supports read-only SELECT and PRAGMA statements.');
}

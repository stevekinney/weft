/**
 * Driver-neutral SQL identifier validation shared by adapters that must
 * interpolate a caller-configured schema/table name directly into SQL text
 * (identifiers cannot be bound as query parameters).
 *
 * Originally lived only in `postgres-key-value-queries.ts` as
 * `assertPostgresIdentifier`; extracted here so a second dialect
 * (`cloudflare.ts`) can validate its configurable table name without
 * duplicating the pattern or the injection-safety reasoning.
 *
 * @module storage/sql-identifier
 */

/**
 * The strict identifier grammar every adapter using this module accepts:
 * a letter or underscore, followed by letters, digits, or underscores. The
 * pattern excludes the `"` quote character, so no quote-doubling is required
 * when the validated identifier is later wrapped in double quotes.
 */
export const SQL_IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/i;

/**
 * Validate a SQL identifier (schema or table name) against
 * {@link SQL_IDENTIFIER_PATTERN}. Identifiers cannot be bound as query
 * parameters, so they must be interpolated into SQL text — this validation,
 * run once at construction, is the injection guard that makes interpolation
 * safe.
 *
 * Internal helper: not exported from any package subpath. Callers reach it
 * transitively through dialect-specific wrappers such as
 * `assertPostgresIdentifier` (Postgres) and the Cloudflare Durable Object
 * adapter's table-name validation. No `@example` here for that reason, like
 * the derived `*Core` helpers in `./derived-operations.ts`.
 *
 * @throws {Error} When `value` does not match {@link SQL_IDENTIFIER_PATTERN}.
 */
export function assertSqlIdentifier(value: string, role: string, dialect: string): void {
  if (!SQL_IDENTIFIER_PATTERN.test(value)) {
    throw new Error(
      `${dialect} storage ${role} name "${value}" is not a valid ${dialect} identifier. Use only letters, digits, and underscores, starting with a letter or underscore (matching ${SQL_IDENTIFIER_PATTERN.source}).`,
    );
  }
}

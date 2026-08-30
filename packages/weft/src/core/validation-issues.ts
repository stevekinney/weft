import type { ZodIssue } from 'zod';

/** A flattened Zod issue suitable for cross-transport serialization. */
export type ValidationIssue = {
  readonly path: ReadonlyArray<string | number>;
  readonly message: string;
  readonly code: string;
};

/**
 * Convert a Zod issue into the stable diagnostic shape used by core validators.
 * Path segments outside the JSON-friendly string and number forms are rendered
 * with their string representation, preserving the original issue order.
 */
export function flattenZodIssue(issue: ZodIssue): ValidationIssue {
  const path: Array<string | number> = [];
  for (const segment of issue.path) {
    if (typeof segment === 'string' || typeof segment === 'number') {
      path.push(segment);
    } else {
      path.push(String(segment));
    }
  }
  return { path, message: issue.message, code: issue.code };
}

/**
 * Shared JSON-Schema keyword sets and the error type used by the
 * codegen emitter. Lives in its own module so `codegen-emit.ts`
 * stays under the 500-line per-file budget.
 *
 * @module cli/codegen-emit-keywords
 */

import { WeftError } from '../core/weft-error.ts';

// Annotation-only keywords: documentation, defaults, and validation
// constraints (string length, numeric bounds, array/object size).
// They do not constrain the TypeScript shape, so combinator,
// enum/const, and type/shape dispatchers may safely ignore them
// when checking for sibling assertions. Anything outside this set
// (and outside the per-shape supported keys) is treated as a real
// sibling and forces a degrade to `unknown`.
export const ANNOTATION_ONLY_KEYWORDS: ReadonlySet<string> = new Set([
  'description',
  'title',
  'default',
  '$comment',
  'examples',
  'readOnly',
  'writeOnly',
  'deprecated',
  '$schema',
  '$id',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
]);

/** Keys each per-shape dispatcher in the emitter understands. */
export const PRIMITIVE_SUPPORTED_KEYS = ['type'] as const;
export const OBJECT_SUPPORTED_KEYS = [
  'type',
  'properties',
  'required',
  'additionalProperties',
] as const;
export const ARRAY_SUPPORTED_KEYS = ['type', 'items', 'prefixItems', 'additionalItems'] as const;

/**
 * Thrown by the emitter when the converter cannot produce a type it
 * is willing to stand behind (e.g. recursion overflow). Callers must
 * translate this to a user-facing diagnostic.
 */
export class CodegenEmitError extends WeftError<'CodegenEmitError'> {
  constructor(message: string) {
    super('CodegenEmitError', message);
  }
}

/**
 * Returns true when `node` has any own key not in `expected` and not
 * in {@link ANNOTATION_ONLY_KEYWORDS}. Used by combinator,
 * enum/const, and type/shape dispatchers to detect sibling
 * constraints they cannot compose with.
 */
export function hasUnexpectedSibling(
  node: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  for (const key of Object.keys(node)) {
    if (expected.includes(key)) continue;
    if (ANNOTATION_ONLY_KEYWORDS.has(key)) continue;
    return true;
  }
  return false;
}

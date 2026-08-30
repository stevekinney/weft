/**
 * Standalone fixture exercised by `definition-schema-to-json.subprocess.test.ts`
 * to deterministically gate the Valibot adapter path. Unlike the in-suite
 * Valibot test (which uses `it.skipIf(!canLoadValibot)` to work around Bun's
 * mid-suite require behavior), this script asserts the conversion
 * unconditionally and exits non-zero on any failure — including the
 * `@valibot/to-json-schema` package being missing or broken. The subprocess
 * test runs this file via `bun` and fails the parent suite when the child's
 * exit code is non-zero. Keep this file as a plain Bun script (no test
 * runner) so the assertion can never silently skip.
 */

import * as v from 'valibot';

import { definitionSchemaToJsonSchema } from './definition-schema-to-json.ts';

const schema = v.object({ name: v.string() });
const result = definitionSchemaToJsonSchema(schema);

const expected = {
  type: 'object',
  properties: { name: { type: 'string' } },
};

const actualType = (result as { type?: unknown }).type;
const actualProperties = (result as { properties?: Record<string, unknown> }).properties;
const actualName = actualProperties?.['name'] as { type?: unknown } | undefined;

if (actualType !== expected.type) {
  console.error(
    `[valibot-fixture] expected type="${expected.type}", got ${JSON.stringify(actualType)}`,
  );
  process.exit(1);
}

if (!actualName || actualName.type !== 'string') {
  console.error(
    `[valibot-fixture] expected properties.name.type="string", got ${JSON.stringify(actualName)}`,
  );
  process.exit(1);
}

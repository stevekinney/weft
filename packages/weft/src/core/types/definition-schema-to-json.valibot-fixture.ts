/**
 * Standalone Valibot conversion fixture used by the subprocess regression.
 * Keep this a plain Bun script so it exercises the ordinary runtime loader.
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

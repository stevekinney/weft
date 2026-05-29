#!/usr/bin/env bun

import {
  INTERACTIVE_OPERATION_NAMES,
  isInteractiveOperation,
} from '../src/server/interactive-operations.ts';
import { createLiveOperationRegistry } from '../src/server/rest-bindings.ts';

const failures: string[] = [];

const registry = createLiveOperationRegistry();
const present = new Set<string>();

for (const operation of registry.list()) {
  present.add(operation.name);

  // `summary` is the short one-liner required for EVERY operation.
  if (operation.summary.trim() === '') {
    failures.push(`${operation.name}: missing summary`);
  }

  // `description` is the longer-form prose required only for the
  // interactively-used subset (workflow lifecycle, schedule CRUD, reviews,
  // worker control). The rest of the ~55 operations may omit it.
  if (isInteractiveOperation(operation.name)) {
    if (operation.description === undefined || operation.description.trim() === '') {
      failures.push(`${operation.name}: interactive operation missing description`);
    }
  }
}

// Guard the subset list itself against drift: if an operation is renamed or
// removed, the interactive list must be updated alongside it rather than
// silently referencing a name no live operation provides.
for (const name of INTERACTIVE_OPERATION_NAMES) {
  if (!present.has(name)) {
    failures.push(`${name}: listed as interactive but no live operation provides it`);
  }
}

if (failures.length > 0) {
  console.error(`catalog completeness check failed:\n${failures.join('\n')}`);
  process.exit(1);
}

console.log('catalog completeness: all operations have useful generated metadata');

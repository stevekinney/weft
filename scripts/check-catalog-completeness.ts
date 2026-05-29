#!/usr/bin/env bun

import { createLiveOperationRegistry } from '../src/server/rest-bindings.ts';

const failures: string[] = [];

for (const operation of createLiveOperationRegistry().list()) {
  if (operation.summary.trim() === '') {
    failures.push(`${operation.name}: missing summary`);
  }
}

if (failures.length > 0) {
  console.error(`catalog completeness check failed:\n${failures.join('\n')}`);
  process.exit(1);
}

console.log('catalog completeness: all operations have useful generated metadata');

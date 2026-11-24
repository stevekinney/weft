import { afterEach, describe, expect, it } from 'bun:test';

import { anonymousPrincipal } from "../embedded/backchannel/src/index.ts";
import { MemoryStorage } from "../embedded/storage/src/index.ts";
import { Engine } from '../core/engine.ts';
import { readMcpResource } from './resources.ts';

const engines: Engine[] = [];

afterEach(() => {
  for (const engine of engines.splice(0)) engine[Symbol.dispose]();
});

function context() {
  const engine = new Engine({ storage: new MemoryStorage() });
  engines.push(engine);
  return { engine, principal: anonymousPrincipal(), authRequired: false };
}

describe('readMcpResource with a URI that names no resource', () => {
  it.each([
    ['a workflow resource kind that does not exist', 'weft://workflows/w-1/logs'],
    ['a path with too many segments', 'weft://workflows/w-1/state/extra'],
    ['a path with no workflow id', 'weft://workflows/'],
    ['another host', 'weft://elsewhere/w-1/state'],
    ['another scheme', 'https://workflows/w-1/state'],
    ['text that is not a URI', 'not a uri'],
    ['an undecodable path segment', 'weft://workflows/%E0%A4%A/state'],
  ])('returns null for %s', async (_label, uri) => {
    expect(await readMcpResource(uri, context())).toBeNull();
  });
});

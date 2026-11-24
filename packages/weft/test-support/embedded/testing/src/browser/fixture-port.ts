import { browserPorts } from './browser-ports.ts';

export const FIXTURE_PORT = browserPorts(['FIXTURE_PORT']).FIXTURE_PORT;
export const FIXTURE_ORIGIN = `http://127.0.0.1:${FIXTURE_PORT}`;

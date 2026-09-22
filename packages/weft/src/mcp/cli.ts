#!/usr/bin/env bun

/**
 * The `weft-mcp` binary's published entry point.
 *
 * The manifest's `bin` maps `weft-mcp` to `dist/mcp/cli.js`, which the build
 * transpiles one-for-one from this path. Corvidae keeps the implementation in
 * `src/cli-mcp.ts`, which is a script rather than a module: it parses `Bun.argv`,
 * runs the stdio session and calls `process.exit` at the top level. There is no
 * function to call, so evaluating it is the whole delegation — the binary parses
 * the same flags and exits with the same code as before the rename. The
 * re-export is what forces that evaluation while keeping this file a module;
 * `cli-mcp.ts` declares no exports, so it widens nothing.
 */

export * from '../cli-mcp.ts';

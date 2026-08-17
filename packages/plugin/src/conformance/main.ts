#!/usr/bin/env node
// main.ts — the process entry for the headless conformance rail.
//
// Kept SEPARATE from cli.ts so the importable core (cli.ts) carries no
// `import.meta`. The plugin now imports `runConformance` from cli.ts for the
// read-only `obsidian_conformance_debt` tool, and esbuild cannot represent
// `import.meta` in the plugin's CJS bundle (it warns and shims it). Isolating
// the process-entry guard here keeps cli.ts bundle-clean while preserving direct
// invocation: `node --import tsx src/conformance/main.ts --root=<path> …`.

import { runCli } from "./cli.js";

runCli(process.argv.slice(2)).catch((e) => {
  process.stderr.write(`conformance: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 3;
});

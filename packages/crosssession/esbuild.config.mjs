import esbuild from "esbuild";

const production = process.argv.includes("production");

// No build-time defines: like the triage satellite (and unlike skills) this
// plugin bundles no assets — the whole surface is four MCP tools over the pure
// entry/receipt core.
await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian", "electron", "@codemirror/state", "@codemirror/view",
    "@lezer/common", "node:net", "node:fs", "node:os", "node:path",
  ],
  format: "cjs",
  platform: "node",
  target: "es2022",
  outfile: "main.js",
  sourcemap: production ? false : "inline",
  minify: production,
  logLevel: "info",
});

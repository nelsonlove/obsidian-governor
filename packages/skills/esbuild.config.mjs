import esbuild from "esbuild";
import * as fs from "node:fs";

const production = process.argv.includes("production");

// The bundled "new-skill" static skill: its SKILL.md + conventions.md are
// embedded at build time and emitted by the exporter into the output dir
// (src/kernel/static-skills.ts reads these defines), so a single export
// produces the complete Claude Code plugin with no symlink. Absent assets ⇒
// empty defines ⇒ STATIC_FILES is empty, exactly as under tsx (tests), which
// run without the defines at all. Moved here with the module at the S4
// extraction — the host has no assets/ directory any more.
const readAsset = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "");

await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian", "electron", "@codemirror/state", "@codemirror/view",
    "@lezer/common", "node:net", "node:fs", "node:os", "node:path",
  ],
  format: "cjs",
  // The compiler core reads and writes the export directory directly, so the
  // node built-ins stay external (Obsidian's renderer provides them; this is an
  // isDesktopOnly plugin).
  platform: "node",
  target: "es2022",
  define: {
    __NEW_SKILL_MD__: JSON.stringify(readAsset("assets/new-skill/SKILL.md")),
    __NEW_SKILL_CONVENTIONS__: JSON.stringify(readAsset("assets/new-skill/conventions.md")),
  },
  outfile: "main.js",
  sourcemap: production ? false : "inline",
  minify: production,
  logLevel: "info",
});

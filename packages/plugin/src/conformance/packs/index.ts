// packs/index.ts — the built-in rule packs. The vocab + scheme module adapters
// are the first two; the ported legacy checks (drift/blueprint/ste/port) land
// here in phase 2. A plain list for now; when the config-host (worker-3) lands,
// the pack registry subscribes to it (each pack's SurfaceDocs entry) rather
// than inventing its own directory.

export { vocabPack, VOCAB_PACK_ID } from "./vocab.js";
export { schemePack, SCHEME_PACK_ID } from "./scheme.js";

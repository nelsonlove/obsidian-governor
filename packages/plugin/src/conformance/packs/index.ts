// packs/index.ts — the built-in rule packs. The vocab + scheme module adapters
// came first; the ported legacy checks land here as native packs. Of the four
// legacy Python scripts, three are now ported (structure ← conformance_check,
// port ← port_lint, ste ← ste_lint); drift_audit remains Python-only for now.
// A plain list for now; when the config-host (worker-3) lands, the pack
// registry subscribes to it (each pack's SurfaceDocs entry) rather than
// inventing its own directory.

export { vocabPack, VOCAB_PACK_ID } from "./vocab.js";
export { schemePack, SCHEME_PACK_ID } from "./scheme.js";
export { structurePack, STRUCTURE_PACK_ID, DEFAULT_BLUEPRINT_ROOT } from "./structure.js";
export { portPack, PORT_PACK_ID } from "./port.js";
export { stePack, STE_PACK_ID } from "./ste.js";

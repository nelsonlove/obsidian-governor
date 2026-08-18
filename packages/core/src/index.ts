export { ok, fail } from "./responses.js";

// ── Accept-forbidden guard (issue #104) ─────────────────────────────────────
// packages/core's own copy of the predicate + the canonical leading-frontmatter
// recognizer (stripLeadingBom / LEADING_FRONTMATTER_RE, matching PR #129's
// definition in the plugin — core cannot import from plugin, so this is a
// parallel, not a shared, definition; unifying the two is a follow-up once
// #129 has landed and settled). Every fs-backend write primitive
// (fs-backend/vault.ts's VaultImpl, which both FilesystemBackend and
// packages/server's fs-failover singleton functions call) routes through this
// one implementation.
export {
  AcceptForbiddenError,
  acceptTransitionReason,
  acceptForbiddenReason,
  frontmatterOf,
  leadingFrontmatterBlock,
  stripLeadingFrontmatter,
  parseGuardFrontmatter,
  stripLeadingBom,
  LEADING_FRONTMATTER_RE,
  // Declared protected properties (#224) — the generalized perimeter.
  DEFAULT_PROTECTED_PROPERTIES,
  normalizeProtectedProperties,
  setDeclaredProtectedProperties,
  declaredProtectedProperties,
  declaredGradeOf,
  canonicalPropertyKey,
  findPropertiesCanonical,
  frontmatterValuesEqual,
  acceptTransitionNeedsBefore,
  parseProtectedPropertyLines,
  formatProtectedPropertyLines,
} from "./accept-guard.js";
export type { ProtectedProperty, ProtectedPropertyGrade } from "./accept-guard.js";
export {
  SHARED_ANNOTATIONS,
  FS_TOOLS,
  PROP_RE,
  FmValue,
} from "./tool-registry.js";
export type { Capability, ToolDef, ToolAnnotations } from "./tool-registry.js";
export { registerFsTools } from "./register-fs-tools.js";
export type { RegisterFsToolsOpts, IndexStatusSnapshot } from "./register-fs-tools.js";
export type {
  VaultBackend,
  FrontmatterScalar,
  FrontmatterEditValue,
  FrontmatterValue,
  NoteRef,
  SearchHit,
  SearchMode,
  ReadNoteResult,
  ReadNoteError,
  ReadNotesResult,
  PatchAnchor,
  PatchOp,
  ResolveResult,
  OutlinkEntry,
  FrontmatterSearchResult,
  ManageFrontmatterResult,
} from "./vault-backend.js";

// ── Filesystem backend ──────────────────────────────────────────────────────

export { FilesystemBackend } from "./fs-backend/filesystem-backend.js";

// Vault filesystem functions (module-level, bound to process.env.VAULT_PATH)
export {
  CHARACTER_LIMIT,
  decodeHtmlEntities,
  vaultRoot,
  resolveInVault,
  listNotes,
  readNote,
  writeNote,
  appendNote,
  searchNotes,
  listFolders,
  findByTag,
  setFrontmatterField,
  deleteFrontmatterField,
  getFrontmatterField,
  patchNote,
  deleteNote,
  moveNote,
  createVaultAt,
} from "./fs-backend/vault.js";
export type { VaultImpl } from "./fs-backend/vault.js";

// Index store functions (module-level singleton) and per-instance class
export {
  buildIndex,
  indexStatus,
  resolveRefs,
  getBacklinks,
  getOutlinks,
  searchByFrontmatter,
  getIndexedFrontmatter,
  applyAddOrChange,
  applyUnlink,
  parseAllFrontmatter,
  parseOutlinks,
  deriveJdIdFromPath,
  IndexStore,
} from "./fs-backend/index-store.js";
export type { IndexStatus, IndexedNote } from "./fs-backend/index-store.js";

// Vault watcher
export { startVaultWatcher } from "./fs-backend/vault-watcher.js";
export type { VaultWatcherOptions, VaultWatcherHandle } from "./fs-backend/vault-watcher.js";

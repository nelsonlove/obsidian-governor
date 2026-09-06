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
  isAuthorityFamilyKey,
  findPropertiesCanonical,
  frontmatterValuesEqual,
  acceptTransitionNeedsBefore,
  unverifiableProtectedPropertyIn,
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

// Sessions — the CONTRACT only (suite split, S3, condition 7: "the HOST keeps
// minting ... SessionV1 therefore becomes a published contract"). The mint
// itself (`openSession`) stays host-side, because minting is a host
// responsibility, not because of where a dependency happens to live.
export {
  SESSION_TTL_MS,
  SessionNotLiveError,
  isLive,
  livenessOf,
  expiryRefusal,
  attachMandate,
  closeSession,
  revokeSession,
  expireSession,
} from "./session.js";
export type { SessionId, SessionStatus, SessionV1 } from "./session.js";

// Dispositions — the GENERIC descriptor substrate only (suite split, S3,
// condition 9). Triage's own descriptors stay host-side (triage is a future
// satellite, and the provider must not depend on a satellite); the provider's
// acceptance-specific unions and verb table stay with the provider.
export {
  dispositionsForSurface,
  dispositionByIdIn,
  gestureGatedIn,
} from "./dispositions.js";
export type { DispositionAuthority, DispositionDescriptorShape } from "./dispositions.js";

// Canonical JSON + digests — published as contracts at the suite split's S3
// (condition 9). The host needs them for its OWN session scope digest, which
// is a host assertion about a connection, so they cannot stay provider-internal.
export { canonicalize, NoncanonicalValueError } from "./canonical-json.js";
export type { CanonicalValue } from "./canonical-json.js";
export { digestBytes, digestUtf8, isSha256Digest } from "./digest.js";
export type { Sha256Digest } from "./digest.js";

// Id generation — shared, not host-private: the provider mints ids too
// (gesture.ts, contracts/ids.ts), and forking the mint would give one vault
// two id formats.
export { uuidv7 } from "./uuidv7.js";

// Guarded territories — vault areas neither half of the suite may review,
// capture, or retain copies of. PUBLISHED rather than held as host config
// (suite split, S3, condition 9's ruling): its importers land on both sides of
// the split, and the alternative — two copies — is the failure its own header
// names, where a prefix missing from capture's list means capture writes note
// bodies to disk. Issue #321 still owns making the list real configuration.
export { EXCLUDED_PREFIXES, isExcludedTerritory } from "./territories.js";

// Path-allowlist visibility — the one-path disclosure predicate, published at
// the skills satellite extraction (suite split, S4). A satellite that filters
// what it discloses must ask the SAME question the host asks; a forked copy of
// a guard predicate is the drift this repo has already paid for twice. The
// host's guard.ts keeps everything that knows the tool surface's argument
// shapes (mapPaths / collectPaths / guardCall / visiblePaths) and defines its
// allowlist branch over this function.
export { isVisible } from "./visibility.js";
export type { GuardSettings } from "./visibility.js";

// `resolveScope` — the validator for a bare `scope` STRING argument, published
// at the read-tier satellite extraction (suite split, S7) for the same reason
// as `isVisible`, and with the same alternative declined. A `scope` is not in
// the host's PATH_KEYS, so the guard never sees it and every tool taking one
// must check it by hand; `obsidian_lint` did not until 2026-08-29, which was a
// live read-boundary bypass. When that tool left for the `vault-health`
// satellite the choice was publish or fork, and forking a guard predicate is
// the drift this repo has paid for three times. Its two callers are now in
// different plugins: the host's `obsidian_check_links` and the health
// satellite's lint. `normalizePosix` rides along because the host's
// `tools-scheme.ts` needs the identical normalizer for its own scope handling
// and core is where the one copy now lives.
export { resolveScope } from "./scope.js";
export type { ScopeRefusal } from "./scope.js";
export { normalizePosix } from "./visibility.js";

// ── The controlled-vocabulary kernel (suite split, S7) ──────────────────────
//
// Published INTO core rather than moved into the `vault-vocab` satellite,
// because it has TWO consumers and always did: the four vocabulary tools (now
// the satellite's) and the HOST's conformance rail — `conformance/packs/vocab.ts`
// wraps `noteVocabFindings`, `conformance/cli.ts` builds a `VocabRegistry` per
// run, `conformance/snapshot.ts` and `rule-pack.ts` are typed over `VocabNote`,
// and `obsidian-drift-source.ts` / `obsidian-debt-source.ts` fall back to
// `DEFAULT_VOCABULARIES`. This is exactly the shape of the `queryBaseRows`
// question the triage extraction answered by leaving the seam behind, and it
// has the same forbidden answer: two copies of a rule core is how one vault
// gets two vocabularies. Conformance is itself a planned satellite
// (suite-split-design.md §6), so core is where both consumers end up meeting.
//
// It qualifies on the same grounds `isVisible` did: pure, Obsidian-free, no MCP
// SDK, no host types — it already imported `leadingFrontmatterBlock` from here
// before the move.
export { VocabAmbiguousError, asStrings } from "./vocab/provider.js";
export type {
  VocabCapabilities,
  VocabEntry,
  VocabFinding,
  VocabKind,
  VocabularyProvider,
} from "./vocab/provider.js";
export { blueprintProvider, scanFrontmatter } from "./vocab/blueprint.js";
export type { BlueprintConfig, VocabNote } from "./vocab/blueprint.js";
export { glossaryProvider, parseTermsSection, DEFAULT_GLOSSARY_CONFIG } from "./vocab/glossary.js";
export type { GlossaryConfig } from "./vocab/glossary.js";
export { noteVocabFindings } from "./vocab/findings.js";
export type { NoteVocabInput } from "./vocab/findings.js";
export {
  scopeTagsProvider,
  scopeTagsFindings,
  validateScopeTagsConfig,
  DEFAULT_SCOPE_TAGS_CONFIG,
} from "./vocab/scope-tags.js";
export type { ScopeTagsConfig, ScopeTagsProvider } from "./vocab/scope-tags.js";
export { VocabRegistry, DEFAULT_VOCABULARIES, VOCAB_PROVIDERS, isVocabProvider } from "./vocab/registry.js";
export type { VocabInstance, VocabInstanceSettings, VocabProviderName } from "./vocab/registry.js";

// The QuickAdd executeChoice seam, published at the triage satellite extraction
// (suite split, S5) for the same reason as `isVisible`. Its own header already
// said it exists so the two surfaces that drive a choice headlessly "cannot
// drift on how a choice is resolved and invoked" — and after S5 those two
// surfaces are in DIFFERENT PLUGINS: the host's `obsidian_run_command` (the
// agent-named path, gated by the cli-policy opaque-execution deny) and the
// triage satellite's declared `choice` dispositions (the human-bound path,
// where the config binding IS the human re-enable). Copying it into the
// satellite would have made the drift the file was written to prevent. It
// contains NO policy decision and takes `app` duck-typed, so it carries no
// `obsidian` import and belongs here cleanly.
export { executeQuickAddChoice } from "./quickadd-choice.js";
export type { ChoiceOutcome } from "./quickadd-choice.js";

// module.ts — the Module contract: the seam between the plugin's tool surface
// and a capability module (scope provider, vocabulary provider, future) that
// contributes tools as a settings-toggleable unit. This is the container half
// of the module consolidation ruling (Assent, 2026-08-09); the modules
// themselves live in their own kernel directories (kernel/scheme/,
// kernel/vocab/) and plug in behind this shape.
//
// Kernel-module rules apply: nothing here imports from "obsidian" or the MCP
// SDK, not even types — the registrar surface is structurally typed against
// the (guard-patched) `server.registerTool`, so a module registered through
// the host is guarded, serialized and journaled exactly like a hand-registered
// tool, and the whole host is unit-testable without a vault or an SDK server.

/**
 * How a module faces the bridge.
 *
 *   - "capability" — faces agents; full surface (tools, later agents/skills).
 *   - "governance" — faces the human; a deliberately ONE-WAY, read-only
 *     surface (Stewardship's shape: it may read the journal/baseline and
 *     expose a pending status, it contributes no mutation and no accept).
 *
 * The v1 host REFUSES governance modules outright (ModuleRegistry reports the
 * refusal in `problems` and the module is inert): folding the governance
 * module in is gated on a fresh accept-reachability review of the merged
 * topology. The posture exists in the type now so the host's contract already
 * understands that a governance module's surface is asymmetric — when the
 * gate lifts, the registry's posture check narrows instead of the interface
 * changing shape.
 */
export type ModulePosture = "capability" | "governance";

/** A tool registration's definition block, structurally compatible with what
 * `McpServer.registerTool` takes (title/description/inputSchema/annotations).
 * Deliberately loose: the host forwards it, it does not interpret it — except
 * `annotations.readOnlyHint`, the single mutating/read-only discriminant the
 * guard keys on. */
export interface ToolDef {
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; [k: string]: unknown };
  [k: string]: unknown;
}

/** A tool handler as the SDK sees it: args in, result envelope out. The host
 * never calls handlers; it only carries them to the registrar. */
export type ToolHandler = (args: never, extra?: unknown) => unknown;

/**
 * The registration surface a module writes into. Structurally the
 * (guard-patched) `server.registerTool`, so passing `(n, d, h) =>
 * server.registerTool(n, d, h)` — or the fake server in tests — satisfies it.
 * Every tool contributed through the host therefore lands at the SAME
 * interception point as every hand-registered tool: guarded, queued,
 * journaled, kernel-args-declared, with no module-specific bypass possible.
 */
export type ToolRegistrar = (name: string, def: ToolDef, handler: ToolHandler) => void;

/**
 * What the host hands a module at registration time. Everything is optional:
 * a module must degrade (register fewer tools, or none, with its own
 * messaging) rather than throw when a dependency is absent — mirroring how
 * tools-uid.ts answers with a typed failure when the kernel is missing.
 */
export interface ModuleHostCtx {
  /** The guard's settings accessor (readOnly / allowlist / …), passed through
   * verbatim so modules filter their answers with `visiblePaths` exactly like
   * the built-in tools. Typed loose to keep this file free of guard imports —
   * modules narrow it to `GuardSettings` themselves. */
  getSettings?: () => unknown;
  /**
   * The allowlist filter itself — paths in, the visible subset out (the
   * `visiblePaths`/`VisibleFilter` shape the read-boundary slice injects into
   * ObsidianBackend). The host wires it at mount time so a module filters
   * WITHOUT importing guard.ts. The read-boundary rule binds modules exactly
   * as it binds built-in tools: any tool that enumerates or reads vault
   * content bounds its own answers by this filter BEFORE it reads — a module
   * that ignores it re-opens the path/content oracle the slice-3.0 review
   * closed three times over. Absent (tests, bare embeds) ⇒ nothing is
   * filtered, matching `visiblePaths` with no allowlist.
   */
  visible?: (paths: string[]) => string[];
  /** The plugin-singleton kernel (queue/journal/locks/uids) when active. */
  kernel?: unknown;
  /**
   * Module-specific injected dependencies, keyed by MODULE id — a scope
   * provider's file listing, a vocabulary's note source. The host carries the
   * map opaquely; each module (or its adapter's `ctxOf`) picks out its own
   * entry. Keying by module id keeps two modules' sources from colliding
   * without the host knowing either one's shape.
   */
  sources?: Record<string, unknown>;
}

/** A module's user-facing configuration contract: defaults the registry merges
 * UNDER the user's `modules.<id>.config`, and an optional validator whose
 * findings land in `ModuleRegistry.problems` (reported, never thrown —
 * settings are user-edited, and one bad value must not take the module system
 * down). */
export interface ModuleSettingsSchema {
  defaults?: Record<string, unknown>;
  validate?(config: Record<string, unknown>): string[];
}

/**
 * A capability module as the host sees it: identity + posture + declared
 * capabilities for enumeration, a default enabled state that plugin settings
 * override per id, an optional settings contract, and the one verb —
 * `register`, called once per built server, only when the module is
 * effectively enabled, with the merged config.
 */
export interface VaultModule {
  /** Unique across the registry; also the module's key in plugin settings
   * (`modules.<id>`) and in `ModuleHostCtx.sources`. */
  id: string;
  posture: ModulePosture;
  /** Declared capability names, for enumeration/discoverability — e.g.
   * ["addressing", "allocation"] or ["vocabulary"]. Free-form strings; the
   * host lists them, it does not interpret them. */
  capabilities: string[];
  /** Default enabled state. `ModuleSettings[id].enabled` overrides it. */
  enabled: boolean;
  settingsSchema?: ModuleSettingsSchema;
  register(reg: ToolRegistrar, host: ModuleHostCtx, config: Record<string, unknown>): void;
}

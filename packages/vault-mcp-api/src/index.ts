// src/index.ts
import type { Plugin } from "obsidian";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// ── Boundary types (mirror packages/plugin/src/mcp/external-tools.ts) ────────

export interface JsonSchemaObject {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
}

export interface ExternalToolSpec {
  name: string;
  description: string;
  inputSchema?: JsonSchemaObject;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  handler: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}

/**
 * The host's tool-publishing api, mirrored from
 * packages/plugin/src/mcp/external-tools.ts and pinned against it by
 * tests/contract.test.ts.
 *
 * `unregisterTools(ownerPluginId)` was REMOVED from both sides by S2 of the
 * suite split: it was addressed by owner id, so any caller holding the api
 * object could revoke any publisher's tools. The disposer `registerTools`
 * returns is now the only revocation path — which is what `publishTools` below
 * has always used, so nothing in this SDK changes behaviour. `apiVersion` stays
 * 1: the host removed a method it never needed to offer and added the
 * governance seam beside it, and neither changes what a publisher sends.
 */
export interface VaultMcpApi {
  apiVersion: 1;
  registerTools(ownerPluginId: string, tools: ExternalToolSpec[]): () => void;
}

// ── Publisher-facing spec ─────────────────────────────────────────────────────

export interface SdkToolSpec {
  /** Bare name, /^[a-z][a-z0-9_]*$/; published as `<your-plugin-id>_<name>`. */
  name: string;
  description: string;
  /** A zod raw shape ({ path: z.string() }) or a plain JSON Schema object. */
  inputSchema?: Record<string, z.ZodTypeAny> | JsonSchemaObject;
  /** Omitted or false ⇒ the tool counts as MUTATING (blocked by Governor's read-only mode). */
  readOnly?: boolean;
  /** Set true if the tool can destroy user data (delete/overwrite); advisory hint surfaced to MCP clients. */
  destructive?: boolean;
  /** Set true if repeated identical calls have no additional effect. */
  idempotent?: boolean;
  handler: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}

/**
 * The host plugin's id, newest first. Governor renamed its plugin id
 * `vault-mcp` → `governor` in 0.12.0; the npm package name of this SDK did
 * NOT change (it is a published contract). So the SDK reads BOTH ids and
 * subscribes to BOTH ready events — one SDK build works against a host on
 * either side of the migration, exactly mirroring the host, which fires
 * `governor:ready` and the legacy `vault-mcp:ready` during the grace period.
 * Order is significant: on a vault that still has a stale (disabled-but-
 * present) legacy install, the new id must win.
 */
const HOST_PLUGIN_IDS = ["governor", "vault-mcp"] as const;
/** Ready events, same order and same reason as HOST_PLUGIN_IDS. */
const HOST_READY_EVENTS = ["governor:ready", "vault-mcp:ready"] as const;
const API_VERSION = 1;

function isJsonSchema(s: NonNullable<SdkToolSpec["inputSchema"]>): s is JsonSchemaObject {
  // A zod raw shape's values are zod schemas, never the string "object",
  // so checking type alone discriminates safely — and accepts a valid
  // property-less JSON Schema like { type: "object" }.
  return (s as JsonSchemaObject).type === "object";
}

function toJsonSchema(s: SdkToolSpec["inputSchema"]): JsonSchemaObject | undefined {
  if (!s) return undefined;
  if (isJsonSchema(s)) return s;
  // Convert INSIDE the publisher's bundle — zod instances must not cross the
  // plugin boundary (each plugin bundles its own zod copy).
  const js = zodToJsonSchema(z.object(s as Record<string, z.ZodTypeAny>), {
    target: "jsonSchema7",
    $refStrategy: "none",
  }) as Record<string, unknown>;
  delete js.$schema;
  return js as unknown as JsonSchemaObject;
}

function toExternalSpec(t: SdkToolSpec): ExternalToolSpec {
  return {
    name: t.name,
    description: t.description,
    inputSchema: toJsonSchema(t.inputSchema),
    annotations: {
      readOnlyHint: t.readOnly === true,
      ...(t.destructive !== undefined && { destructiveHint: t.destructive }),
      ...(t.idempotent !== undefined && { idempotentHint: t.idempotent }),
    },
    handler: t.handler,
  };
}

/**
 * Publish MCP tools through Governor. Call from your plugin's onload() and
 * hand the returned disposer to this.register(). Handles load order (registers
 * now or on the host's ready event), re-registration when the host reloads,
 * cleanup. Works against a host on either side of the 0.12.0 `vault-mcp` →
 * `governor` id migration — see HOST_PLUGIN_IDS.
 */
export function publishTools(plugin: Plugin, tools: SdkToolSpec[]): () => void {
  const specs = tools.map(toExternalSpec);
  let unregister: (() => void) | null = null;

  const getApi = (): VaultMcpApi | null => {
    const loaded = (plugin.app as unknown as {
      plugins?: { plugins?: Record<string, { api?: VaultMcpApi }> };
    }).plugins?.plugins;
    for (const id of HOST_PLUGIN_IDS) {
      const api = loaded?.[id]?.api;
      if (!api) continue;
      if (api.apiVersion !== API_VERSION) {
        console.warn(`[vault-mcp-api] '${id}' apiVersion ${api.apiVersion} ≠ supported ${API_VERSION}; not registering '${plugin.manifest.id}' tools`);
        return null;
      }
      return api;
    }
    return null;
  };

  const register = () => {
    const api = getApi();
    if (!api) return;
    try { unregister = api.registerTools(plugin.manifest.id, specs); }
    catch (e) { console.error(`[vault-mcp-api] registerTools failed for '${plugin.manifest.id}'`, e); }
  };

  register(); // the host may already be loaded
  // On host reload the old registry died with the old plugin instance — drop
  // the stale unregister (don't call it) and register into the new one.
  // Subscribing to both events means a single 0.12.0+ host load runs this
  // twice; that is harmless by the host's own contract — same-owner
  // re-registration REPLACES by tool name, and the superseded disposer is
  // object-identity guarded, so it cannot delete the newer entries.
  const refs = HOST_READY_EVENTS.map((evt) =>
    plugin.app.workspace.on(evt as never, () => { unregister = null; register(); }),
  );

  return () => {
    for (const ref of refs) plugin.app.workspace.offref(ref);
    try { unregister?.(); } catch { /* registry may already be gone */ }
    unregister = null;
  };
}

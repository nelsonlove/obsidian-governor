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
  annotations?: { readOnlyHint?: boolean };
  handler: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}

export interface VaultMcpApi {
  apiVersion: 1;
  registerTools(ownerPluginId: string, tools: ExternalToolSpec[]): () => void;
  unregisterTools(ownerPluginId: string): void;
}

// ── Publisher-facing spec ─────────────────────────────────────────────────────

export interface SdkToolSpec {
  /** Bare name, /^[a-z][a-z0-9_]*$/; published as `<your-plugin-id>_<name>`. */
  name: string;
  description: string;
  /** A zod raw shape ({ path: z.string() }) or a plain JSON Schema object. */
  inputSchema?: Record<string, z.ZodTypeAny> | JsonSchemaObject;
  /** Omitted or false ⇒ the tool counts as MUTATING (blocked by vault-mcp read-only mode). */
  readOnly?: boolean;
  handler: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}

const VAULT_MCP_ID = "vault-mcp";
const API_VERSION = 1;

function isJsonSchema(s: NonNullable<SdkToolSpec["inputSchema"]>): s is JsonSchemaObject {
  return (s as JsonSchemaObject).type === "object" &&
    typeof (s as JsonSchemaObject).properties === "object";
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
    annotations: { readOnlyHint: t.readOnly === true },
    handler: t.handler,
  };
}

/**
 * Publish MCP tools through vault-mcp. Call from your plugin's onload() and
 * hand the returned disposer to this.register(). Handles load order (registers
 * now or on `vault-mcp:ready`), re-registration when vault-mcp reloads, cleanup.
 */
export function publishTools(plugin: Plugin, tools: SdkToolSpec[]): () => void {
  const specs = tools.map(toExternalSpec);
  let unregister: (() => void) | null = null;

  const getApi = (): VaultMcpApi | null => {
    const api = (plugin.app as unknown as {
      plugins?: { plugins?: Record<string, { api?: VaultMcpApi }> };
    }).plugins?.plugins?.[VAULT_MCP_ID]?.api;
    if (!api) return null;
    if (api.apiVersion !== API_VERSION) {
      console.warn(`[vault-mcp-api] vault-mcp apiVersion ${api.apiVersion} ≠ supported ${API_VERSION}; not registering '${plugin.manifest.id}' tools`);
      return null;
    }
    return api;
  };

  const register = () => {
    const api = getApi();
    if (!api) return;
    try { unregister = api.registerTools(plugin.manifest.id, specs); }
    catch (e) { console.error(`[vault-mcp-api] registerTools failed for '${plugin.manifest.id}'`, e); }
  };

  register(); // vault-mcp may already be loaded
  // On vault-mcp reload the old registry died with the old plugin instance —
  // drop the stale unregister (don't call it) and register into the new one.
  const ref = plugin.app.workspace.on("vault-mcp:ready" as never, () => { unregister = null; register(); });

  return () => {
    plugin.app.workspace.offref(ref);
    try { unregister?.(); } catch { /* registry may already be gone */ }
    unregister = null;
  };
}

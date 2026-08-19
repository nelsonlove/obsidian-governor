# vault-mcp-api

Publisher SDK for [Governor](https://github.com/nelsonlove/obsidian-governor)'s external tool registry: let your Obsidian plugin publish MCP tools to Claude Code through Governor's bridge.

> **Canonical home moved (2026-08-19, #86):** this package now lives in the
> Governor monorepo at `packages/vault-mcp-api` of
> [nelsonlove/obsidian-governor](https://github.com/nelsonlove/obsidian-governor),
> next to the host side of the contract
> (`packages/plugin/src/mcp/external-tools.ts`) and a contract test that pins
> the two together. The old standalone repo
> ([nelsonlove/vault-mcp-api](https://github.com/nelsonlove/vault-mcp-api)) is
> to be archived; existing `github:nelsonlove/vault-mcp-api#v1.0.0` installs
> keep working from the archive. The published npm package name is unchanged.

> **Host renamed in 0.12.0, this package did not.** The host plugin's id moved
> `vault-mcp` → `governor` (and the product is now called Governor). The npm
> package name stays `vault-mcp-api` — it is a published contract, and renaming
> it would strand consumers for no user-visible gain. The SDK is **dual-id**:
> it looks the host up under `governor` first and falls back to `vault-mcp`,
> and it waits on both `governor:ready` and the legacy `vault-mcp:ready`. One
> SDK build therefore works against a host on either side of the migration.

## Install

    npm install vault-mcp-api

(Until the first monorepo-published version reaches npm, the pinned install from the old repo still works: `npm install github:nelsonlove/vault-mcp-api#v1.0.0`.)

`obsidian` and `zod` are peer dependencies (any plugin build already has the former; npm ≥7 auto-installs the latter).

## Use

    import { publishTools } from "vault-mcp-api";
    import { z } from "zod";

    // in your plugin's onload():
    this.register(
      publishTools(this, [{
        name: "my_tool",                 // published as <your-plugin-id>_my_tool
        description: "What it does.",
        inputSchema: { arg: z.string().describe("…") },  // or plain JSON Schema
        readOnly: false,                 // omit/false ⇒ blocked in Governor's read-only mode
        handler: async ({ arg }) => ({ result: "plain JSON out" }),
      }])
    );

Rules: tool `name` must match `/^[a-z][a-z0-9_]*$/`; published tool names must not collide with Governor's built-in `obsidian_*` namespace (registration throws a TypeError if the namespaced name would start with `obsidian_`). Handlers return plain JSON-serializable values (Governor wraps them) and thrown errors become MCP tool errors; tools appear to Claude Code sessions on their next connect. Requires a Governor host with `apiVersion: 1`; on a version mismatch the SDK logs a warning and registers nothing.

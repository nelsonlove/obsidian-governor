# vault-mcp-api

Publisher SDK for the [vault-mcp](https://github.com/nelsonlove/obsidian-vault-mcp-plugin) external tool registry: let your Obsidian plugin publish MCP tools to Claude Code through vault-mcp's bridge.

## Install

    npm install github:nelsonlove/vault-mcp-api#v1.0.0

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
        readOnly: false,                 // omit/false ⇒ blocked in vault-mcp read-only mode
        handler: async ({ arg }) => ({ result: "plain JSON out" }),
      }])
    );

Rules: tool `name` must match `/^[a-z][a-z0-9_]*$/`; published tool names must not collide with vault-mcp's built-in `obsidian_*` namespace (registration throws a TypeError if the namespaced name would start with `obsidian_`). Handlers return plain JSON-serializable values (vault-mcp wraps them) and thrown errors become MCP tool errors; tools appear to Claude Code sessions on their next connect. Requires vault-mcp with `apiVersion: 1`; on a version mismatch the SDK logs a warning and registers nothing.

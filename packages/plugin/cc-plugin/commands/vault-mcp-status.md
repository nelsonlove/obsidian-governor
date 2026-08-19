---
name: vault-mcp-status
description: Report whether the Governor Obsidian bridge (historically vault-mcp) is live and which vault it's serving.
---

Check Governor connectivity and report the result to the user:

1. Call the `mcp__governor__obsidian_doctor` tool. If that tool prefix does not
   exist in this session (a pre-0.12.0 registration), call
   `mcp__vault-mcp__obsidian_doctor` instead.
2. **If it returns**, summarize what it reports — the bound vault, socket path, and
   plugin version — and confirm Governor is live and its MCP tools are available.
3. **If the call fails or the server is unavailable**, tell the user Governor is
   **down**: its MCP tools will fail this session. Fix: open Obsidian and enable
   the "Governor" community plugin (Settings → Community plugins), then run
   `/mcp` and reconnect (server name `governor`; pre-0.12.0 registrations were
   named `vault-mcp`).

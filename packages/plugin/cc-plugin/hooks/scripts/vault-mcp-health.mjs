#!/usr/bin/env node
// vault-mcp connectivity probe — shared by the SessionStart hook and the
// /vault-mcp-status command.
//
//   (no args)   hook mode: SILENT when a vault socket is live; emits a
//               SessionStart context heads-up ONLY when the socket is down, so
//               the agent knows the mcp__vault-mcp__* tools will fail. Always
//               exits 0 — a health check must never block the session.
//   --verbose   command mode: always prints a plain-text status line.
//
// Node is a hard dependency of vault-mcp (the bridge runs on it), so relying on
// it here is safe. No third-party modules, no jq.
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const verbose = process.argv.includes("--verbose");
// 0.12.0 id migration: the canonical state dir is ~/.claude/governor/; the old
// ~/.claude/vault-mcp/ is still read so a pre-migration plugin is seen too.
// Entries marked `legacy: true` in the old dir are the new plugin's own compat
// copies of files already present in the new dir — skipped, or one vault would
// count twice.
const DIR = path.join(os.homedir(), ".claude", "governor");
const LEGACY_DIR = path.join(os.homedir(), ".claude", "vault-mcp");
const FIX =
  "open Obsidian and enable the 'Governor' plugin (Settings → Community plugins), then run /mcp and reconnect (server name 'governor'; pre-0.12.0 registrations were named 'vault-mcp')";

function readDiscoveryDir(dir, skipLegacy) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (skipLegacy && d.legacy === true) continue;
      out.push(d);
    } catch {
      /* skip malformed discovery */
    }
  }
  return out;
}

function readDiscoveries() {
  return [...readDiscoveryDir(DIR, false), ...readDiscoveryDir(LEGACY_DIR, true)];
}

// A socket file on disk isn't proof of life — probe it for a real connection.
function probe(socketPath) {
  return new Promise((resolve) => {
    const s = net.createConnection(socketPath);
    const done = (ok) => {
      s.destroy();
      resolve(ok);
    };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    s.setTimeout(1000, () => done(false));
  });
}

// Plain text for --verbose; JSON context injection for the SessionStart hook.
function report({ ok, plain, context }) {
  if (verbose) {
    process.stdout.write(plain + "\n");
  } else if (context) {
    // Cover both documented SessionStart context mechanisms.
    process.stdout.write(
      JSON.stringify({
        systemMessage: context,
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: context,
        },
      }) + "\n"
    );
  }
  process.exit(0);
}

async function main() {
  const discos = readDiscoveries();

  if (discos.length === 0) {
    // Never installed / plugin has never run — not our place to nag a session.
    return report({
      ok: false,
      plain: `vault-mcp: no vault discovery found in ${DIR} (or the legacy ${LEGACY_DIR}) — the Obsidian 'Governor' plugin hasn't run yet.`,
      context: null,
    });
  }

  const results = await Promise.all(
    discos.map(async (d) => ({ d, live: await probe(d.socket_path) }))
  );
  const live = results.filter((r) => r.live).map((r) => r.d.vault_name);
  const dead = results.filter((r) => !r.live).map((r) => r.d.vault_name);

  if (live.length > 0) {
    return report({
      ok: true,
      plain: `vault-mcp: live ✓  vault(s): ${live.join(", ")} — tools are available (mcp__governor__*, or mcp__vault-mcp__* on a pre-0.12.0 registration).`,
      context: null, // healthy → stay silent in the session
    });
  }

  // Discovery exists but nothing is accepting — the exact state the bridge can't
  // self-heal (Obsidian closed / plugin disabled / mid-session restart).
  return report({
    ok: false,
    plain: `vault-mcp: DOWN — discovery exists (${dead.join(", ") || "unknown"}) but no socket is accepting. Fix: ${FIX}.`,
    context: `vault-mcp is not serving a socket right now (Obsidian closed or the 'Governor' plugin disabled), so every mcp__governor__* (or legacy mcp__vault-mcp__*) tool call will fail this session. To use them, ${FIX}. Stale discovery: ${dead.join(", ") || "none"}.`,
  });
}

// A health check must never throw its way into blocking a session.
main().catch(() => process.exit(0));

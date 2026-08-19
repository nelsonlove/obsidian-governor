import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeDiscovery, removeDiscovery } from "../src/discovery.ts";

test("writeDiscovery writes canonical + legacy compat copy; removeDiscovery removes both", () => {
  const slug = `t${process.pid}`;
  const d = {
    socket_path: "/x.sock", vault_path: "/v", vault_name: slug,
    plugin_version: "0.1.0", obsidian_version: "1.6.6", started_at: "2026-01-01T00:00:00",
  };
  writeDiscovery(slug, d);

  // Canonical discovery in the 0.12.0 namespace — no legacy flag.
  const canonical = path.join(os.homedir(), ".claude", "governor", `${slug}.json`);
  const c = JSON.parse(fs.readFileSync(canonical, "utf8"));
  assert.equal(c.vault_name, slug);
  assert.equal(c.legacy, undefined, "the canonical copy must not be marked legacy");

  // Grace-period compat copy in the pre-0.12.0 namespace: `legacy: true`,
  // pointing at the SAME (new) socket so old registrations keep working.
  const legacy = path.join(os.homedir(), ".claude", "vault-mcp", `${slug}.json`);
  const l = JSON.parse(fs.readFileSync(legacy, "utf8"));
  assert.equal(l.legacy, true);
  assert.equal(l.socket_path, d.socket_path, "legacy copy points at the new socket");
  assert.equal(l.vault_name, slug);

  removeDiscovery(slug);
  assert.equal(fs.existsSync(canonical), false);
  assert.equal(fs.existsSync(legacy), false);
});

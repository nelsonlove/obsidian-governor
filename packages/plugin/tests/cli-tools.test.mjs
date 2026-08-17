/**
 * cli-tools.test.mjs — obsidian_cli (official-CLI proxy) pure logic + handler.
 *
 * The exec layer is injected, so the handler is fully testable headlessly:
 * danger gate, allowlist refusal, arg construction, and result shaping.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  findObsidianBinary,
  isDangerousCliCommand,
  buildCliArgs,
  registerCliTools,
  cliAcceptRefusal,
  contentAcceptRefusal,
  expandCliEscapes,
  expandCliEscapesRich,
  scanForAcceptFence,
  CLI_OPAQUE_ACCEPT_RESIDUAL,
} from "../src/mcp/tools-cli.js";
import { fakeServer } from "./fake-server.mjs";
import { parseYaml } from "./obsidian-stub.mjs";

// ── findObsidianBinary ────────────────────────────────────────────────────────

describe("findObsidianBinary", () => {
  test("returns the first existing candidate", () => {
    const bin = findObsidianBinary({
      candidates: ["/a/obsidian", "/b/obsidian"],
      fileExists: (p) => p === "/b/obsidian",
    });
    assert.equal(bin, "/b/obsidian");
  });
  test("returns null when nothing exists", () => {
    assert.equal(findObsidianBinary({ candidates: ["/a"], fileExists: () => false }), null);
  });
});

// ── isDangerousCliCommand ─────────────────────────────────────────────────────

describe("isDangerousCliCommand", () => {
  for (const cmd of ["eval", "devtools", "restart", "reload", "command", "plugins:restrict", "plugin:install", "plugin:uninstall", "dev:cdp", "dev:screenshot"]) {
    test(`${cmd} is dangerous`, () => assert.equal(isDangerousCliCommand(cmd), true));
  }
  for (const cmd of ["help", "history:list", "theme:set", "plugin:enable", "plugin:disable", "developer"]) {
    test(`${cmd} is not dangerous`, () => assert.equal(isDangerousCliCommand(cmd), false));
  }
});

// ── buildCliArgs ──────────────────────────────────────────────────────────────

describe("buildCliArgs", () => {
  test("pins the vault first, then command, params, flags", () => {
    assert.deepEqual(
      buildCliArgs({
        vaultName: "my vault",
        command: "history:list",
        params: { file: "Inbox/Note.md", limit: 5, verbose: true },
        flags: ["--json"],
      }),
      ["vault=my vault", "history:list", "file=Inbox/Note.md", "limit=5", "verbose=true", "--json"]
    );
  });
  test("trims the command", () => {
    assert.deepEqual(buildCliArgs({ vaultName: "v", command: " help " }), ["vault=v", "help"]);
  });
  test("rejects a vault param (pinned)", () => {
    assert.throws(() => buildCliArgs({ vaultName: "v", command: "read", params: { vault: "other" } }), /pinned/);
  });
  test("rejects malformed command names", () => {
    for (const bad of ["", "help me", "read; rm", "--json", "1abc"]) {
      assert.throws(() => buildCliArgs({ vaultName: "v", command: bad }), /invalid command/);
    }
  });
  test("rejects mixed-case command names (danger-gate case-bypass hardening)", () => {
    for (const bad of ["Eval", "DEV:cdp", "Help"]) {
      assert.throws(() => buildCliArgs({ vaultName: "v", command: bad }), /invalid command/);
    }
  });
  test("rejects malformed param keys", () => {
    assert.throws(() => buildCliArgs({ vaultName: "v", command: "read", params: { "bad key": "x" } }), /invalid param key/);
  });
  test("rejects non-flag flags", () => {
    assert.throws(() => buildCliArgs({ vaultName: "v", command: "read", flags: ["json"] }), /invalid flag/);
    assert.throws(() => buildCliArgs({ vaultName: "v", command: "read", flags: ["extra=positional"] }), /invalid flag/);
  });
  test("accepts flag=value", () => {
    assert.deepEqual(
      buildCliArgs({ vaultName: "v", command: "read", flags: ["--format=json", "-v"] }),
      ["vault=v", "read", "--format=json", "-v"]
    );
  });
});

// ── registerCliTools handler ──────────────────────────────────────────────────

// rawCliProxy: true — the proxy is demoted behind a default-OFF setting; these
// tests exercise the ENABLED proxy's behavior (the default-off gate has its own
// tests below).
function ctxWith(settings) {
  return {
    pluginVersion: "0.0.0-test",
    socketPath: "/tmp/x.sock",
    vaultName: "testvault",
    enabledPlugins: () => [],
    getSettings: () => ({ readOnly: false, allowlist: [], allowDangerousCli: false, rawCliProxy: true, ...settings }),
  };
}

const okExec = async (bin, args) => ({ exitCode: 0, stdout: `ran ${args.join(" ")}`, stderr: "", timedOut: false });

describe("registerCliTools", () => {
  test("does not register without a binary", () => {
    const server = fakeServer();
    registerCliTools(server, ctxWith({}), { binary: null });
    assert.equal(server.tools.size, 0);
  });

  test("does not register when the Raw CLI proxy setting is off (the demotion default)", () => {
    const server = fakeServer();
    registerCliTools(server, ctxWith({ rawCliProxy: false }), { binary: "/bin/obsidian", exec: okExec });
    assert.equal(server.tools.size, 0);
  });

  test("does not register when the setting is absent entirely (default off, fail closed)", () => {
    const server = fakeServer();
    registerCliTools(server, ctxWith({ rawCliProxy: undefined }), { binary: "/bin/obsidian", exec: okExec });
    assert.equal(server.tools.size, 0);
  });

  test("registers when the Raw CLI proxy setting is on and behaves as before", async () => {
    const server = fakeServer();
    registerCliTools(server, ctxWith({}), { binary: "/bin/obsidian", exec: okExec });
    assert.ok(server.tools.get("obsidian_cli"));
    const res = await server.tools.get("obsidian_cli").handler({ command: "help" });
    assert.notEqual(res.isError, true);
  });

  test("registers obsidian_cli with mutating annotations", () => {
    const server = fakeServer();
    registerCliTools(server, ctxWith({}), { binary: "/usr/local/bin/obsidian", exec: okExec });
    const entry = server.tools.get("obsidian_cli");
    assert.ok(entry);
    assert.equal(entry.def.annotations.readOnlyHint, false);
  });

  test("happy path: structured report with argv, exit_code, stdout", async () => {
    const server = fakeServer();
    registerCliTools(server, ctxWith({}), { binary: "/bin/obsidian", exec: okExec });
    const res = await server.tools.get("obsidian_cli").handler({ command: "help" });
    assert.notEqual(res.isError, true);
    assert.equal(res.structuredContent.exit_code, 0);
    assert.deepEqual(res.structuredContent.argv, ["vault=testvault", "help"]);
    assert.match(res.structuredContent.stdout, /^ran vault=testvault help/);
  });

  test("non-zero exit keeps the structured report but flags isError", async () => {
    const server = fakeServer();
    const exec = async () => ({ exitCode: 3, stdout: "partial", stderr: "boom", timedOut: false });
    registerCliTools(server, ctxWith({}), { binary: "/bin/obsidian", exec });
    const res = await server.tools.get("obsidian_cli").handler({ command: "read" });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent.exit_code, 3);
    assert.equal(res.structuredContent.stderr, "boom");
  });

  test("dangerous command is blocked by default, with the setting named", async () => {
    const server = fakeServer();
    // `restart` is dangerous but NOT in the opaque-accept set, so the danger
    // gate is the one that fires (eval/command hit the command policy first —
    // pinned in cli-policy.test.mjs).
    registerCliTools(server, ctxWith({}), { binary: "/bin/obsidian", exec: okExec });
    const res = await server.tools.get("obsidian_cli").handler({ command: "restart" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Allow dangerous CLI commands/);
  });

  test("dangerous command runs when allowDangerousCli is on", async () => {
    const server = fakeServer();
    // eval also needs the command policy's per-command re-enable now — the
    // fail-closed default of the opaque-accept set (cli-policy.ts).
    registerCliTools(
      server,
      ctxWith({ allowDangerousCli: true, cliPolicy: { deny: [], allowOpaque: ["eval"] } }),
      { binary: "/bin/obsidian", exec: okExec }
    );
    const res = await server.tools.get("obsidian_cli").handler({ command: "eval", params: { code: "1+1" } });
    assert.notEqual(res.isError, true);
  });

  test("refuses to run while a path allowlist is active", async () => {
    const server = fakeServer();
    registerCliTools(server, ctxWith({ allowlist: ["00-09 System"] }), { binary: "/bin/obsidian", exec: okExec });
    const res = await server.tools.get("obsidian_cli").handler({ command: "help" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /allowlist/);
  });

  test("invalid input surfaces as a tool error, not a throw", async () => {
    const server = fakeServer();
    registerCliTools(server, ctxWith({}), { binary: "/bin/obsidian", exec: okExec });
    const res = await server.tools.get("obsidian_cli").handler({ command: "read", params: { vault: "other" } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /pinned/);
  });

  test("timeout surfaces timed_out plus the may-have-completed note", async () => {
    const server = fakeServer();
    const exec = async () => ({ exitCode: null, stdout: "", stderr: "", timedOut: true });
    registerCliTools(server, ctxWith({}), { binary: "/bin/obsidian", exec });
    const res = await server.tools.get("obsidian_cli").handler({ command: "search", timeout_ms: 1000 });
    assert.equal(res.isError, true);
    assert.equal(res.structuredContent.timed_out, true);
    assert.match(res.structuredContent.note, /may still have completed/);
  });

  test("mixed-case dangerous command is rejected outright (never executed)", async () => {
    const server = fakeServer();
    let executed = false;
    const exec = async () => { executed = true; return { exitCode: 0, stdout: "", stderr: "", timedOut: false }; };
    registerCliTools(server, ctxWith({}), { binary: "/bin/obsidian", exec });
    const res = await server.tools.get("obsidian_cli").handler({ command: "Eval" });
    assert.equal(res.isError, true);
    assert.equal(executed, false);
  });
});

// ── cliAcceptRefusal — the accept-forbidden guard on the CLI path (pure) ───────
//
// The scar "the accept verb goes in no API" reaches the CLI proxy here, reusing
// the SAME accepted-family rule as the MCP write primitive. property:set and
// content writes that would INTRODUCE acceptance are refused; everything else,
// including acceptance-status: proposed, is clean.

describe("cliAcceptRefusal — property:set family", () => {
  test("REJECTS acceptance-status=accepted (documented name=/value= form)", () => {
    assert.ok(cliAcceptRefusal("property:set", { name: "acceptance-status", value: "accepted", file: "Note" }, parseYaml));
  });
  test("REJECTS acceptance-status=accepted (direct shorthand form)", () => {
    assert.ok(cliAcceptRefusal("property:set", { "acceptance-status": "accepted" }, parseYaml));
  });
  test("REJECTS acceptance_status underscore variant", () => {
    assert.ok(cliAcceptRefusal("property:set", { name: "acceptance_status", value: "accepted" }, parseYaml));
  });
  test("REJECTS an accepted-* prefixed value (accepted-by-review)", () => {
    assert.ok(cliAcceptRefusal("property:set", { name: "acceptance-status", value: "accepted-by-review" }, parseYaml));
  });
  for (const key of ["accepted", "accepted-by", "accepted-on", "accepted_by", "accepted_on"]) {
    test(`REJECTS the provenance key ${key} (name=/value= form)`, () => {
      assert.ok(cliAcceptRefusal("property:set", { name: key, value: "Nelson" }, parseYaml));
    });
    test(`REJECTS the provenance key ${key} (shorthand form)`, () => {
      assert.ok(cliAcceptRefusal("property:set", { [key]: "Nelson" }, parseYaml));
    });
  }
  test("frontmatter:add alias is guarded too", () => {
    assert.ok(cliAcceptRefusal("frontmatter:set", { name: "acceptance-status", value: "accepted" }, parseYaml));
  });
  // ── ALLOWED — legitimate property sets are untouched ──
  test("ALLOWS acceptance-status=proposed (the value agents DO write)", () => {
    assert.equal(cliAcceptRefusal("property:set", { name: "acceptance-status", value: "proposed" }, parseYaml), null);
  });
  test("ALLOWS a property literally named 'status' set to 'accepted' (not the acceptance field)", () => {
    assert.equal(cliAcceptRefusal("property:set", { name: "status", value: "accepted" }, parseYaml), null);
  });
  test("ALLOWS a normal property:set foo=bar", () => {
    assert.equal(cliAcceptRefusal("property:set", { name: "foo", value: "bar", file: "Note" }, parseYaml), null);
  });
  test("ALLOWS property:get / property:remove (not set-family)", () => {
    assert.equal(cliAcceptRefusal("property:get", { name: "acceptance-status" }, parseYaml), null);
    assert.equal(cliAcceptRefusal("property:remove", { name: "acceptance-status" }, parseYaml), null);
  });
});

describe("cliAcceptRefusal — content writes (create/append/prepend + periodic)", () => {
  const fence = (v) => `---\nacceptance-status: ${v}\n---\nbody`;
  for (const cmd of ["create", "append", "prepend", "base:create", "daily:append", "weekly:prepend", "monthly:create"]) {
    test(`REJECTS ${cmd} whose content carries an accepted fence`, () => {
      assert.ok(cliAcceptRefusal(cmd, { content: fence("accepted") }, parseYaml));
    });
  }
  test("REJECTS base:create with an accepted fence (same name=/content= writer as create)", () => {
    assert.ok(cliAcceptRefusal("base:create", { name: "My Base", content: fence("accepted") }, parseYaml));
  });
  test("ALLOWS a normal base:create (no acceptance)", () => {
    assert.equal(cliAcceptRefusal("base:create", { name: "My Base", content: "# View\n\nrows" }, parseYaml), null);
  });
  test("REJECTS an accepted-family VALUE array form (acceptance-status: [accepted])", () => {
    assert.ok(cliAcceptRefusal("create", { content: "---\nacceptance-status: [accepted]\n---\nx" }, parseYaml));
  });
  test("REJECTS a block-sequence accepted form", () => {
    assert.ok(cliAcceptRefusal("create", { content: "---\nacceptance-status:\n  - accepted\n---\nx" }, parseYaml));
  });
  test("REJECTS an accepted-by provenance key in a fence", () => {
    assert.ok(cliAcceptRefusal("append", { content: "---\naccepted-by: Nelson\n---\n" }, parseYaml));
  });
  test("REJECTS an escaped-newline fence (\\n interpreted by the CLI)", () => {
    assert.ok(cliAcceptRefusal("create", { content: "---\\nacceptance-status: accepted\\n---\\nbody" }, parseYaml));
  });
  test("REJECTS an embedded (non-leading) accepted fence, conservatively", () => {
    assert.ok(cliAcceptRefusal("append", { content: "some body\n\n---\nacceptance-status: accepted\n---\n" }, parseYaml));
  });
  // ── ALLOWED — legitimate content writes are untouched ──
  test("ALLOWS a plain content write with no frontmatter", () => {
    assert.equal(cliAcceptRefusal("append", { content: "New line" }, parseYaml), null);
  });
  test("ALLOWS content whose fence sets acceptance-status: proposed", () => {
    assert.equal(cliAcceptRefusal("create", { content: fence("proposed") }, parseYaml), null);
  });
  test("ALLOWS a heading that merely mentions the word accepted in prose", () => {
    assert.equal(cliAcceptRefusal("create", { content: "# Accepted papers\n\nNotes about accepted submissions." }, parseYaml), null);
  });
  test("fails CLOSED on a fence when no parser is injected", () => {
    assert.ok(cliAcceptRefusal("create", { content: fence("proposed") }, undefined));
  });
});

// ── #107: flag-form arguments come under the accept rule too ──────────────────
//
// buildCliArgs pushes `flags` verbatim into argv, so a guarded key expressed in
// flag form (`--name=acceptance-status --value=accepted`, `--content=<fence>`)
// once reached the CLI having been inspected only in `params`. cliAcceptRefusal
// now takes `flags` and, for the guarded families, (a) fails closed on a guarded
// key carried as a VALUELESS flag and (b) folds every --key=value flag into the
// same predicate the params take. Ordinary flags (`--json`) stay clean.

describe("cliAcceptRefusal — flag-form arguments (#107)", () => {
  test("REJECTS property:set acceptance in name=/value= flag form", () => {
    assert.ok(cliAcceptRefusal("property:set", undefined, parseYaml, ["--name=acceptance-status", "--value=accepted"]));
  });
  test("REJECTS property:set acceptance in direct shorthand flag form", () => {
    assert.ok(cliAcceptRefusal("property:set", undefined, parseYaml, ["--acceptance-status=accepted"]));
  });
  test("REJECTS an accepted-provenance key as a value-bearing flag", () => {
    assert.ok(cliAcceptRefusal("property:set", undefined, parseYaml, ["--accepted-by=Nelson"]));
  });
  test("REJECTS acceptance split ACROSS params and flags (name in params, value in flag)", () => {
    assert.ok(cliAcceptRefusal("property:set", { name: "acceptance-status" }, parseYaml, ["--value=accepted"]));
  });
  test("REJECTS acceptance split the other way (value in params, name in flag)", () => {
    assert.ok(cliAcceptRefusal("property:set", { value: "accepted" }, parseYaml, ["--name=acceptance-status"]));
  });
  test("REJECTS content-write acceptance carried in a --content flag", () => {
    assert.ok(cliAcceptRefusal("create", undefined, parseYaml, ["--content=---\\nacceptance-status: accepted\\n---\\nbody"]));
  });
  // ── fail closed on the uninspectable valueless form ──
  for (const key of ["name", "value", "content", "acceptance-status", "acceptance_status", "accepted-by", "accepted-on"]) {
    test(`REJECTS a valueless guarded flag --${key} (its value could arrive as a following argv token)`, () => {
      assert.ok(cliAcceptRefusal("property:set", undefined, parseYaml, [`--${key}`]));
    });
  }
  // ── ordinary flags stay clean ──
  test("ALLOWS an ordinary --json flag on a guarded family", () => {
    assert.equal(cliAcceptRefusal("property:set", { name: "foo", value: "bar" }, parseYaml, ["--json"]), null);
    assert.equal(cliAcceptRefusal("create", { content: "# Hi" }, parseYaml, ["--json"]), null);
  });
  test("ALLOWS name=/value= flags that set a non-acceptance property", () => {
    assert.equal(cliAcceptRefusal("property:set", undefined, parseYaml, ["--name=status", "--value=accepted"]), null);
  });
  test("ALLOWS a valueless flag on an UNGUARDED command (no accept scope)", () => {
    assert.equal(cliAcceptRefusal("read", undefined, parseYaml, ["--content", "--name"]), null);
  });
});

// ── #153: the CLI content path decides over EVERY plausible escape reading ────
//
// The guard reconstructs the honored document by un-escaping a param value, but
// the exact escape semantics of the external CLI are unsettled. Rather than bet
// the accept boundary on one reading, contentAcceptRefusal expands under all
// three coherent readings (R1 shipped / R2 escaped-escape keep-unknown / R3
// escaped-escape drop-unknown) and refuses if ANY asserts acceptance in a fence.
// These fixtures PIN THE PROPERTY across the escape semantics, not one string:
// each payload lands acceptance in a fence under at least one plausible reading
// while the OLD single-reading (R1) reconstruction is blind to it — the exact
// gap #153 closes — so the guard must refuse every one.

describe("expandCliEscapes — the escaped-escape readings (R2/R3)", () => {
  test("R2 keeps an unrecognized \\X literal; R3 drops the backslash", () => {
    assert.equal(expandCliEscapes(String.raw`\-\-\-`, "keep"), String.raw`\-\-\-`);
    assert.equal(expandCliEscapes(String.raw`\-\-\-`, "drop"), "---");
  });
  test("both collapse an escaped escape \\\\ to a single backslash", () => {
    assert.equal(expandCliEscapes(String.raw`a\\b`, "keep"), String.raw`a\b`);
    assert.equal(expandCliEscapes(String.raw`a\\b`, "drop"), String.raw`a\b`);
  });
  test("an even run before n stays literal under escaped-escape (no newline)", () => {
    // `\\n` = escaped escape + literal n — the divergence from R1, which would
    // emit `\`+newline by matching `\n` at the second backslash.
    assert.equal(expandCliEscapes(String.raw`x\\ny`, "keep"), String.raw`x\ny`);
    assert.equal(expandCliEscapes(String.raw`x\\ny`, "drop"), String.raw`x\ny`);
  });
  test("recognized escapes still expand (\\n, \\r\\n, \\t)", () => {
    assert.equal(expandCliEscapes(String.raw`a\nb`, "keep"), "a\nb");
    assert.equal(expandCliEscapes(String.raw`a\r\nb`, "keep"), "a\nb");
    assert.equal(expandCliEscapes(String.raw`a\tb`, "drop"), "a\tb");
  });
});

describe("expandCliEscapesRich — the maximal decoder reading (R4, #153 axis 2)", () => {
  test("decodes \\xHH hex escapes to their code points", () => {
    assert.equal(expandCliEscapesRich(String.raw`\x2d\x2d\x2d`), "---");
    assert.equal(expandCliEscapesRich(String.raw`a\x0ab`), "a\nb");
  });
  test("decodes \\uHHHH and \\u{H…} unicode escapes", () => {
    assert.equal(expandCliEscapesRich("\\u002d\\u002d"), "--"); // 4-digit \uHHHH branch
    assert.equal(expandCliEscapesRich(String.raw`\u{2d}\u{2d}`), "--");
  });
  test("decodes octal \\NNN escapes", () => {
    assert.equal(expandCliEscapesRich(String.raw`\55\55\55`), "---"); // \55 = 0o55 = '-'
    assert.equal(expandCliEscapesRich(String.raw`a\12b`), "a\nb"); // \12 = 0o12 = LF
  });
  test("collapses an escaped escape and drops letter escapes exactly as R3 (R4 = R3 + numeric)", () => {
    assert.equal(expandCliEscapesRich(String.raw`a\\b`), String.raw`a\b`);
    // Ambiguous C letters drop to their letter, NOT to a control char (`\e`→e,
    // not ESC), so R4 covers R3's letter-drop rather than opening a gap with it.
    assert.equal(expandCliEscapesRich(String.raw`accept\ed`), "accepted");
    assert.equal(expandCliEscapesRich(String.raw`\a\b\f\v`), "abfv");
  });
  test("a malformed numeric escape falls back to dropping the backslash", () => {
    assert.equal(expandCliEscapesRich(String.raw`a\xZq`), "axZq");
    assert.equal(expandCliEscapesRich(String.raw`a\u00zzb`), "au00zzb");
  });
});

describe("contentAcceptRefusal — refuses under EVERY plausible reading (#153)", () => {
  // Each payload is written with the escape sequences a CLI param would carry.
  // `refuse` asserts BOTH the low-level predicate and the CLI-command wrapper,
  // and PINS THE BLIND SPOT: the old single-reading (R1) reconstruction —
  // expanding only the recognized `\n`/`\r\n`/`\t` escapes — does NOT assert
  // acceptance, so it is the multi-reading logic (R2/R3), not R1, that catches
  // these. That is exactly the gap #153 closes.
  const refuse = (name, content) =>
    test(`REFUSES: ${name}`, () => {
      assert.ok(contentAcceptRefusal(content, parseYaml), `contentAcceptRefusal should refuse: ${content}`);
      assert.ok(cliAcceptRefusal("create", { content }, parseYaml), `cliAcceptRefusal should refuse: ${content}`);
      const r1 = content.replace(/\\r\\n|\\n/g, "\n").replace(/\\t/g, "\t");
      assert.equal(scanForAcceptFence(r1, parseYaml), null,
        `R1-only reconstruction should be blind (the #153 gap): ${JSON.stringify(r1)}`);
    });

  // R3 (drop unknown): `\-\-\-` collapses to a bare `---` fence.
  refuse("escaped fence dashes (\\-\\-\\-) around an accepted status",
    String.raw`\-\-\-\nacceptance-status: accepted\n\-\-\-`);
  // R3: a dropped backslash inside the value spells `accepted`.
  refuse("escaped char inside the accepted value (accept\\ed)",
    String.raw`---\nacceptance-status: accept\ed\n---`);
  // R3: a dropped backslash on the KEY spells `acceptance-status`.
  refuse("escaped char on the acceptance-status key",
    String.raw`---\n\acceptance-status: accepted\n---`);
  // Mixed: escaped fence dashes + an accepted-by provenance key with a drop.
  refuse("escaped fence dashes around an accepted-by provenance key",
    String.raw`\-\-\-\naccepted-by: Nelson\n\-\-\-`);
  // Triple-escape adversarial variant on the dashes.
  refuse("triple-escaped dashes still collapse to a fence",
    String.raw`\-\-\-\nacceptance-status: accepted\n\-\-\-\nbody`);
  // Escaped-escape at a fence boundary combined with a dropped key backslash.
  refuse("escaped-escape mixed with a dropped key backslash",
    String.raw`\-\-\-\n\acceptance-status: accepted\n\-\-\-`);

  // Axis 2 (#153, independent review): a CLI that decodes NUMERIC escapes can
  // encode the whole fence — `\x2d`→'-', `\x0a`→a real LF — invisibly to
  // R1/R2/R3. R4 (the maximal decoder) refuses these.
  refuse("hex-escaped fence + status (\\x2d / \\x0a)",
    String.raw`\x2d\x2d\x2d\x0aacceptance-status:\x20accepted\x0a\x2d\x2d\x2d`);
  refuse("unicode-escaped fence + status (\\uHHHH)",
    "\\u002d\\u002d\\u002d\\u000aacceptance-status:\\u0020accepted\\u000a\\u002d\\u002d\\u002d");
  refuse("braced-unicode-escaped fence + status (\\u{H…})",
    String.raw`\u{2d}\u{2d}\u{2d}\u{0a}acceptance-status: accepted\u{0a}\u{2d}\u{2d}\u{2d}`);
  refuse("octal-escaped fence + status (\\NNN)",
    String.raw`\55\55\55\12acceptance-status: accepted\12\55\55\55`);
});

describe("contentAcceptRefusal — benign escape-bearing content is NOT refused (#153 false-positive bound)", () => {
  const allow = (name, content) =>
    test(`ALLOWS: ${name}`, () =>
      assert.equal(contentAcceptRefusal(content, parseYaml), null, `should allow: ${content}`));

  // Escape sequences (\\, \-, \n, \t) but NO acceptance assertion anywhere.
  allow("a Windows-style path with backslash sequences",
    String.raw`---\nstatus: proposed\n---\nWindows path C:\Users\name and C:\temp\notes`);
  allow("prose mentioning accepted, not in a fence",
    String.raw`A note about accepted papers.\nSee C:\temp\notes`);
  allow("escaped fence dashes but no acceptance assertion inside",
    String.raw`\-\-\-\ntitle: some dashes \-\-\-\n\-\-\-\nbody`);
  allow("escaped-escape sequences with the word accepted on a non-acceptance key",
    String.raw`---\nnote: reviewed and accepted by hand\\nsee log\n---`);
  allow("a proposed fence written with escape sequences",
    String.raw`---\nacceptance-status: proposed\n---\nbody`);
  allow("escaped escapes and drops that never form a fence + assertion together",
    String.raw`Path: C:\\server\\share — status \accepted informally in chat`);
  // Axis 2: numeric escape sequences (hex/unicode/octal) that decode under R4
  // but never form a fence asserting acceptance — bounds R4's false-positive surface.
  allow("hex and unicode escapes in prose, no acceptance fence",
    String.raw`Color \x23ff0000, accent \u00e9, path C:\x2ftmp — reviewed and accepted informally`);
  allow("a proposed fence alongside benign hex escapes",
    String.raw`---\nstatus: proposed\n---\ncodes \x41\x42 and \u0043 are not acceptance`);
});

describe("cliAcceptRefusal — unrelated commands are clean", () => {
  for (const cmd of ["read", "search", "history:list", "help", "backlinks", "quickadd", "quickadd:run", "eval", "command"]) {
    test(`${cmd} is not accept-guarded (returns null)`, () => {
      assert.equal(cliAcceptRefusal(cmd, { file: "Note", query: "accepted" }, parseYaml), null);
    });
  }
  test("the opaque-macro set is named for the report/description (authoritative copy in cli-policy.ts)", () => {
    assert.deepEqual(
      [...CLI_OPAQUE_ACCEPT_RESIDUAL].sort(),
      ["command", "eval", "quickadd", "quickadd:run", "quickadd:run-template"],
    );
  });
});

// ── handler integration: refused BEFORE exec, coded Error [accept_forbidden] ───

describe("registerCliTools — accept guard wired into the handler", () => {
  function recordingServer() {
    const server = fakeServer();
    const calls = [];
    const exec = async (bin, args) => { calls.push(args); return { exitCode: 0, stdout: "ok", stderr: "", timedOut: false }; };
    registerCliTools(server, ctxWith({}), { binary: "/bin/obsidian", exec, parseYaml });
    return { handler: server.tools.get("obsidian_cli").handler, calls };
  }

  test("property:set acceptance-status=accepted is refused and NOT executed", async () => {
    const { handler, calls } = recordingServer();
    const res = await handler({ command: "property:set", params: { name: "acceptance-status", value: "accepted", file: "Note" } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Error \[accept_forbidden\]/);
    assert.equal(calls.length, 0);
  });

  test("create with an accepted fence is refused and NOT executed", async () => {
    const { handler, calls } = recordingServer();
    const res = await handler({ command: "create", params: { name: "N", content: "---\nacceptance-status: accepted\n---\nbody" } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /accept_forbidden/);
    assert.equal(calls.length, 0);
  });

  test("append with an accepted fence is refused and NOT executed", async () => {
    const { handler, calls } = recordingServer();
    const res = await handler({ command: "append", params: { file: "N", content: "---\naccepted-on: 2026-08-10\n---\n" } });
    assert.equal(res.isError, true);
    assert.equal(calls.length, 0);
  });

  test("a normal property:set foo=bar runs", async () => {
    const { handler, calls } = recordingServer();
    const res = await handler({ command: "property:set", params: { name: "foo", value: "bar", file: "Note" } });
    assert.notEqual(res.isError, true);
    assert.equal(calls.length, 1);
  });

  test("acceptance-status=proposed runs (agents DO write proposed)", async () => {
    const { handler, calls } = recordingServer();
    const res = await handler({ command: "property:set", params: { name: "acceptance-status", value: "proposed", file: "Note" } });
    assert.notEqual(res.isError, true);
    assert.equal(calls.length, 1);
  });

  test("a normal content write runs", async () => {
    const { handler, calls } = recordingServer();
    const res = await handler({ command: "create", params: { name: "N", content: "# Hello" } });
    assert.notEqual(res.isError, true);
    assert.equal(calls.length, 1);
  });

  test("property:set acceptance in FLAG form is refused and NOT executed (#107)", async () => {
    const { handler, calls } = recordingServer();
    const res = await handler({ command: "property:set", flags: ["--name=acceptance-status", "--value=accepted"] });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Error \[accept_forbidden\]/);
    assert.equal(calls.length, 0);
  });

  test("a valueless guarded flag on a guarded family is refused and NOT executed (#107)", async () => {
    const { handler, calls } = recordingServer();
    const res = await handler({ command: "property:set", flags: ["--acceptance-status"] });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Error \[accept_forbidden\]/);
    assert.equal(calls.length, 0);
  });

  test("an ordinary --json flag on a guarded family still runs (#107)", async () => {
    const { handler, calls } = recordingServer();
    const res = await handler({ command: "property:set", params: { name: "foo", value: "bar" }, flags: ["--json"] });
    assert.notEqual(res.isError, true);
    assert.equal(calls.length, 1);
  });

  test("the former quickadd residual is CLOSED: denied by the command policy, not the accept guard", async () => {
    const { handler, calls } = recordingServer();
    const res = await handler({ command: "quickadd", params: { choice: "Some Macro" } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /cli_denied/);
    assert.equal(calls.length, 0);
    // The accept guard itself still does not match quickadd — the closure is
    // the policy's, and cliAcceptRefusal stays scoped to inspectable writes.
    assert.equal(cliAcceptRefusal("quickadd", { choice: "Some Macro" }, parseYaml), null);
  });
});

/**
 * The embedded-fence sweep is contractually the BROADER of the CLI guard's two
 * halves ("Broader than the write path is fine; narrower is the bypass"). When
 * the shared recognizer's closer became prefix-matched, this sweep kept the old
 * `---`-alone-on-its-line closer and so inverted its own contract — it became
 * the narrower half. Both reviewers of that change found it independently.
 *
 * These pin the contract directly rather than the implementation: whatever the
 * leading recognizer honors, the sweep must also catch when it appears further
 * down a written body.
 */
describe("scanForAcceptFence — the embedded sweep is never narrower than the recognizer", () => {
  for (const [name, closer] of [
    ["ordinary closer", "---"],
    ["four dashes", "----"],
    ["adjacent text", "---x"],
    ["spaced text", "--- x"],
    ["trailing space", "--- "],
  ]) {
    test(`catches an embedded accepted block closed by \`${closer}\` — ${name}`, () => {
      const content = `intro\n\n---\nacceptance-status: accepted\n${closer}\nbody`;
      assert.ok(
        scanForAcceptFence(content, parseYaml),
        `an embedded fence the vault would honor slipped the sweep: closer ${JSON.stringify(closer)}`,
      );
    });
  }

  test("ordinary embedded content is still allowed — the sweep widened, it did not become a blanket refusal", () => {
    assert.equal(scanForAcceptFence("intro\n\n---\ntitle: fine\n----\nbody", parseYaml), null);
    assert.equal(scanForAcceptFence("just prose with --- dashes\nand more", parseYaml), null);
  });
});

// governance_revisions — the read-side discovery listing (parser + tool).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseRevisionRequestCallouts } from "../src/governor/kernel/revision.ts";
import { registerGovernanceRevisionsListTool } from "../src/mcp/tools-governance-revision.ts";

describe("parseRevisionRequestCallouts", () => {
  test("parses date and text from a standard request callout", () => {
    const body = [
      "# Title",
      "",
      "> [!revision-request] Requested changes (2026-08-18)",
      "> Tighten the summary.",
      "> Cover the edge case.",
      "",
      "Body text.",
    ].join("\n");
    const out = parseRevisionRequestCallouts(body);
    assert.equal(out.length, 1);
    assert.equal(out[0].date, "2026-08-18");
    assert.equal(out[0].text, "Tighten the summary.\nCover the edge case.");
  });

  test("multiple callouts each parse; non-request callouts are ignored", () => {
    const body = [
      "> [!revision-request] Requested changes (2026-08-01)",
      "> First ask.",
      "",
      "> [!note] Unrelated callout",
      "> Not a request.",
      "",
      "> [!revision-request] Requested changes",
      "> Second ask, no date.",
    ].join("\n");
    const out = parseRevisionRequestCallouts(body);
    assert.equal(out.length, 2);
    assert.equal(out[0].date, "2026-08-01");
    assert.equal(out[1].date, null);
    assert.equal(out[1].text, "Second ask, no date.");
  });

  test("mirrors the remover: CRLF bodies parse, and a body with no callouts yields []", () => {
    const crlf = "> [!revision-request] Requested changes (2026-08-18)\r\n> Fix EOLs.\r\n";
    const out = parseRevisionRequestCallouts(crlf);
    assert.equal(out.length, 1);
    assert.equal(out[0].text, "Fix EOLs.");
    assert.deepEqual(parseRevisionRequestCallouts("# Nothing here\n\nplain body"), []);
  });
});

// Minimal fake server capturing the one registration.
function fakeServer() {
  const reg = {};
  return {
    reg,
    registerTool(name, def, handler) {
      reg[name] = { def, handler };
    },
  };
}

const NOTE = (status) =>
  `---\nacceptance-status: ${status}\n---\n\n# N\n\n> [!revision-request] Requested changes (2026-08-18)\n> Do the thing.\n`;

describe("governance_revisions tool", () => {
  test("lists only revising notes, parses requests, read-only annotated", async () => {
    const server = fakeServer();
    registerGovernanceRevisionsListTool(server, {
      listNotes: async () => [
        { path: "A/revising.md", frontmatter: { "acceptance-status": "revising" } },
        { path: "A/proposed.md", frontmatter: { "acceptance-status": "proposed" } },
        { path: "A/plain.md", frontmatter: null },
      ],
      read: async (p) => (p === "A/revising.md" ? NOTE("revising") : "# other\n"),
    });
    const t = server.reg["governance_revisions"];
    assert.equal(t.def.annotations.readOnlyHint, true);
    const res = await t.handler({});
    const s = res.structuredContent;
    assert.equal(s.count, 1);
    assert.equal(s.items[0].path, "A/revising.md");
    assert.equal(s.items[0].requests[0].text, "Do the thing.");
    assert.equal(s.items[0].requests[0].date, "2026-08-18");
  });

  test("allowlist filters via isVisible; folder prefix filters; race-deleted note drops", async () => {
    const server = fakeServer();
    registerGovernanceRevisionsListTool(server, {
      listNotes: async () => [
        { path: "Vis/a.md", frontmatter: { "acceptance-status": "revising" } },
        { path: "Hidden/b.md", frontmatter: { "acceptance-status": "revising" } },
        { path: "Vis/sub/c.md", frontmatter: { "acceptance-status": "revising" } },
        { path: "Vis/gone.md", frontmatter: { "acceptance-status": "revising" } },
      ],
      read: async (p) => (p === "Vis/gone.md" ? null : NOTE("revising")),
      getSettings: () => ({ readOnly: false, allowlist: ["Vis"] }),
    });
    const t = server.reg["governance_revisions"];
    const all = (await t.handler({})).structuredContent;
    assert.deepEqual(
      all.items.map((i) => i.path).sort(),
      ["Vis/a.md", "Vis/sub/c.md"]
    );
    const sub = (await t.handler({ folder: "Vis/sub" })).structuredContent;
    assert.deepEqual(sub.items.map((i) => i.path), ["Vis/sub/c.md"]);
  });

  test("cap: truncated flag set and total reported when over 100", async () => {
    const notes = Array.from({ length: 120 }, (_, i) => ({
      path: `N/${String(i).padStart(3, "0")}.md`,
      frontmatter: { "acceptance-status": "revising" },
    }));
    const server = fakeServer();
    registerGovernanceRevisionsListTool(server, {
      listNotes: async () => notes,
      read: async () => NOTE("revising"),
    });
    const s = (await server.reg["governance_revisions"].handler({})).structuredContent;
    assert.equal(s.count, 100);
    assert.equal(s.total_revising, 120);
    assert.equal(s.truncated, true);
  });
});

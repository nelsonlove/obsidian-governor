// Pure, Obsidian-independent rendering helper for the agent-authored "intent" note.
// Ported from obsidian-stewardship/src/intent-view.ts (#83, cycle 2).
//
// Kept out of pane.ts on purpose: pane.ts imports the real `obsidian` runtime, which is
// types-only in this headless test environment (no `obsidian` JS module to import), so nothing
// in pane.ts can be exercised directly by a Node unit test. This module has NO obsidian
// dependency — only a narrow structural interface (`ElFactory`) matching the two Obsidian
// HTMLElement helpers it relies on — so the EXACT render path pane.ts calls can be driven by a
// plain Node test with a fake element tree, proving the escaping property behaviorally rather
// than only by scanning source text.
//
// SECURITY: `intent` is UNTRUSTED, agent-authored free text (up to ~2000 chars). This module may
// ONLY ever place it into a text node via `createSpan({ text })` (which Obsidian implements as
// `el.textContent = text`, never `innerHTML`). It must never be concatenated into a template
// string that reaches innerHTML/insertAdjacentHTML, an attribute, a URL, or any markdown/HTML
// parser (e.g. MarkdownRenderer). Treat it exactly like untrusted user input in a web UI.

export interface ElFactory {
  createDiv(o?: { cls?: string }): ElFactory;
  createSpan(o?: { cls?: string; text?: string }): ElFactory;
}

// Row-display truncation for the (untrusted) intent string — full text is still shown verbatim
// in the detail view. Pure string slicing; the result only ever reaches a text node.
export function truncateIntent(s: string, max = 140): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

// Renders `agent says: <intent>` as two sibling text-only spans inside a wrapper div appended to
// `container`. `full: false` (row subtitle) truncates; `full: true` (detail header) shows the
// raw intent verbatim. In both cases the intent text reaches the DOM through nothing but the
// `text` field of `createSpan`.
export function renderIntent(
  container: ElFactory,
  intent: string,
  opts: { wrapperCls: string; full: boolean },
): void {
  const text = opts.full ? intent : truncateIntent(intent);
  const wrap = container.createDiv({ cls: opts.wrapperCls });
  wrap.createSpan({ cls: "governance-intent-label", text: "agent says: " });
  wrap.createSpan({ cls: "governance-intent-text", text });
}

// QUICKADD CHOICES — the suite's first satellite plugin.
//
// One job: publish the `compile` tool ("QuickAdd choices as notes") to the
// vault-mcp host through vault-mcp-api. No settings, no pane, no state of
// its own — the choice notes ARE the state, QuickAdd's config is the
// output, and the host provides the transport, guard, queue, and journal.
// Without the host installed this plugin loads and does nothing (the SDK
// registers on the host's ready event whenever one appears).

import { Plugin } from "obsidian";
import { publishTools } from "vault-mcp-api";
import { buildCompileTool } from "./tool.js";

export default class QuickAddChoicesPlugin extends Plugin {
  onload(): void {
    this.register(publishTools(this, [buildCompileTool(this.app)]));
  }
}

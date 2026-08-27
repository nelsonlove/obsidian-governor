// QUICKADD CHOICES — the suite's first satellite plugin.
//
// Two jobs, one handler behind both:
//   1. publish the `compile` tool to the vault-mcp host through
//      vault-mcp-api, for agents (tool.ts);
//   2. register two palette commands, for the human who just hand-edited a
//      choice note and wants it applied without asking an agent
//      (commands.ts).
//
// No settings, no pane, no watchers, no state of its own — the choice notes
// ARE the state and QuickAdd's config is the output. Without the host
// installed the commands still work; only the agent-facing tool waits (the
// SDK registers on the host's ready event whenever one appears).
//
// NO FILE WATCHER, deliberately: auto-compiling on every save would rewrite
// another plugin's config on a debounce timer, silently, forever. Compiling
// stays something someone asks for — an agent through the tool, or a human
// through these commands.

import { Notice, Plugin } from "obsidian";
import { publishTools } from "vault-mcp-api";
import { buildCompileTool } from "./tool.js";
import { buildCommands } from "./commands.js";

export default class QuickAddChoicesPlugin extends Plugin {
  onload(): void {
    this.register(publishTools(this, [buildCompileTool(this.app)]));
    for (const command of buildCommands(this.app)) {
      this.addCommand({
        id: command.id,
        name: command.name,
        callback: () => {
          void command.run().then((outcome) => {
            new Notice(outcome.text, outcome.durationMs);
          });
        },
      });
    }
  }
}

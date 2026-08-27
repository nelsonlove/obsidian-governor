// QUICKADD CHOICES — the suite's first satellite plugin.
//
// Two jobs, one handler behind both:
//   1. publish the `run` tool to the vault-mcp host through
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
    // THE HUMAN PATH FIRST (review of #364): the header claims the commands
    // work without the host, so publishing must not be able to take them
    // down. publishTools is internally defensive, which makes this ordering
    // belt rather than fix — but the claim and the code should agree.
    for (const command of buildCommands(this.app)) {
      this.addCommand({
        id: command.id,
        name: command.name,
        callback: () => {
          void command
            .run()
            .then((outcome) => {
              // isError is CONSUMED, not just computed: a Notice is
              // transient and a failure should outlive it.
              if (outcome.isError) console.error(`[quickadd-choices-compile] ${outcome.text}`);
              new Notice(outcome.text, outcome.durationMs);
            })
            // run() is total by construction, and `new Notice` can throw if
            // the plugin was disabled mid-compile — either way an unhandled
            // rejection in a command callback is invisible to everyone.
            .catch((e) => console.error("[quickadd-choices-compile] compile command failed after the fact", e));
        },
      });
    }
    this.register(publishTools(this, [buildCompileTool(this.app)]));
  }
}

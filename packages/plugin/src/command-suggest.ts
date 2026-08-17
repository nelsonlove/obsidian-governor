/*
 * Command-id autocomplete for a settings text input — the same trick as
 * Obsidian's own file/folder suggesters (AbstractInputSuggest, since 1.4.10;
 * our minAppVersion is well past that), applied to registered commands
 * instead of vault paths. Used by the "Re-enabled opaque commands" picker so
 * adding an allowOpaque entry doesn't require typing an exact command id by
 * hand.
 */
import { AbstractInputSuggest, App } from "obsidian";

export interface CommandEntry {
  id: string;
  name: string;
}

export class CommandSuggest extends AbstractInputSuggest<CommandEntry> {
  constructor(app: App, private readonly inputEl: HTMLInputElement) {
    super(app, inputEl);
  }

  private allCommands(): CommandEntry[] {
    // app.commands.commands is not in the public obsidian types — cast
    // required (same cast obsidian_get_command_ids uses server-side).
    const commands = (this.app as any).commands.commands as Record<string, { name: string }>;
    return Object.entries(commands).map(([id, c]) => ({ id, name: c.name }));
  }

  protected getSuggestions(query: string): CommandEntry[] {
    const q = query.toLowerCase();
    return this.allCommands()
      .filter((c) => c.id.toLowerCase().includes(q) || c.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  renderSuggestion(command: CommandEntry, el: HTMLElement): void {
    el.createDiv({ text: command.name });
    el.createDiv({ text: command.id, cls: "setting-item-description" });
  }

  selectSuggestion(command: CommandEntry): void {
    // Write the value and fire the input event so the Setting's onChange runs.
    this.setValue(command.id);
    this.inputEl.trigger("input");
    this.close();
  }
}

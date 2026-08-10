import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type App, TFile, getAllTags } from "obsidian";
import { ok, fail, codedError } from "./helpers.js";
import { visiblePaths } from "../guard.js";
import type { ServerCtx } from "./tools-core.js";
import { runCommandRefusal } from "./cli-policy.js";

const RO = { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false };
const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
// trash is destructive but recoverable (system trash — can be restored)
const DESTRUCTIVE_RECOVERABLE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

export function registerComplementaryTools(server: McpServer, app: App, ctx: ServerCtx) {

  // ── obsidian_trash ──────────────────────────────────────────────────────────
  server.registerTool(
    "obsidian_trash",
    {
      title: "Trash a note",
      description: "Move a note to the system trash (recoverable). Returns {path, trashed:true}.",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path of the note to trash."),
      },
      annotations: DESTRUCTIVE_RECOVERABLE,
    },
    async ({ path: p }) => {
      try {
        const file = app.vault.getAbstractFileByPath(p);
        if (!(file instanceof TFile)) return fail(new Error(`not found: ${p}`));
        await app.vault.trash(file, true); // true = system trash
        return ok({ path: p, trashed: true });
      } catch (e) { return fail(e); }
    }
  );

  // ── obsidian_read_note_parsed ───────────────────────────────────────────────
  server.registerTool(
    "obsidian_read_note_parsed",
    {
      title: "Read note (parsed)",
      description:
        "Return structured metadata from Obsidian's live cache: frontmatter, headings, links, tags, plus the body (content minus the frontmatter block). Read-only.",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path, e.g. 'Projects/Roadmap.md'."),
      },
      annotations: RO,
    },
    async ({ path: p }) => {
      try {
        const file = app.vault.getAbstractFileByPath(p);
        if (!(file instanceof TFile)) return fail(new Error(`not found: ${p}`));

        const cache = app.metadataCache.getFileCache(file);
        const content = await app.vault.read(file);

        // Strip a leading YAML frontmatter block. Regex-based so it doesn't
        // depend on the exact inclusive/exclusive semantics of the cache's
        // frontmatterPosition.end.offset (which differs across versions).
        const body = cache?.frontmatter
          ? content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
          : content;

        return ok({
          path: p,
          frontmatter: cache?.frontmatter ?? null,
          headings: (cache?.headings ?? []).map((h) => ({
            heading: h.heading,
            level: h.level,
            line: h.position.start.line,
          })),
          links: (cache?.links ?? []).map((l) => ({
            link: l.link,
            displayText: l.displayText,
            line: l.position.start.line,
          })),
          tags: cache?.tags ?? [],
          body,
        });
      } catch (e) { return fail(e); }
    }
  );

  // ── obsidian_append_at_heading ──────────────────────────────────────────────
  server.registerTool(
    "obsidian_append_at_heading",
    {
      title: "Append content at a heading",
      description:
        "Insert content at the end of the section under a heading. If create_if_missing=true and the heading is absent, appends the heading + content to the file (creating the file if needed).",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path ending in .md."),
        heading: z.string().min(1).describe("Exact heading text (no leading #)."),
        content: z.string().min(1).describe("Markdown to insert after the heading section's body."),
        create_if_missing: z.boolean().default(false),
      },
      annotations: RW,
    },
    async ({ path: p, heading, content, create_if_missing }) => {
      try {
        if (!p.endsWith(".md")) return fail(new Error("path must end in .md"));
        const file = app.vault.getAbstractFileByPath(p);

        if (!(file instanceof TFile)) {
          if (!create_if_missing) {
            return ok({ path: p, found: false, inserted: false });
          }
          // Create note with the heading + content
          const newContent = `# ${heading}\n\n${content}\n`;
          await app.vault.create(p, newContent);
          return ok({ path: p, found: false, inserted: true, created_note: true });
        }

        const cache = app.metadataCache.getFileCache(file);
        const headings = cache?.headings ?? [];
        const idx = headings.findIndex((h) => h.heading === heading);

        if (idx < 0) {
          if (!create_if_missing) {
            return ok({ path: p, found: false, inserted: false });
          }
          // Append heading + content to file
          await app.vault.append(file, `\n## ${heading}\n\n${content}\n`);
          return ok({ path: p, found: false, inserted: true, created_heading: true });
        }

        const text = await app.vault.read(file);
        const h = headings[idx];
        let sectionEnd = text.length;
        for (let j = idx + 1; j < headings.length; j++) {
          if (headings[j].level <= h.level) {
            sectionEnd = headings[j].position.start.offset;
            break;
          }
        }

        // Append at the end of the section body, preserving trailing newline before next heading
        const head = text.slice(0, sectionEnd).replace(/\n*$/, "\n");
        const tail = text.slice(sectionEnd);
        const sep = tail.length === 0 || tail.startsWith("\n") ? "\n" : "\n\n";
        const next = head + content + sep + tail;

        await app.vault.modify(file, next);
        return ok({ path: p, found: true, inserted: true });
      } catch (e) { return fail(e); }
    }
  );

  // ── obsidian_open_in_editor ─────────────────────────────────────────────────
  server.registerTool(
    "obsidian_open_in_editor",
    {
      title: "Open note in editor",
      description: "Open a note in Obsidian's editor, optionally in a new leaf/tab.",
      inputSchema: {
        path: z.string().min(1).describe("Vault-relative path of the note to open."),
        new_leaf: z.boolean().default(false).describe("Open in a new tab/leaf."),
      },
      annotations: RW,
    },
    async ({ path: p, new_leaf }) => {
      try {
        // openLinkText resolves the path through Obsidian's link resolver.
        await app.workspace.openLinkText(p, "", new_leaf);
        return ok({ path: p, opened: true });
      } catch (e) { return fail(e); }
    }
  );

  // ── obsidian_run_command ────────────────────────────────────────────────────
  server.registerTool(
    "obsidian_run_command",
    {
      title: "Run Obsidian command",
      description:
        "Execute an Obsidian command by its ID (see obsidian_get_command_ids). Optionally open file_path first so file-scoped commands have a target. " +
        "QuickAdd command ids (quickadd:*) run opaque macros the acceptance guard cannot inspect and are DENIED by default (Error [cli_denied]); a human can re-enable a specific id in the vault-mcp settings.",
      inputSchema: {
        command_id: z.string().min(1).describe("Obsidian command ID, e.g. 'editor:toggle-bold'."),
        file_path: z.string().optional().describe("Open this vault-relative path before running the command."),
      },
      annotations: RW,
    },
    async ({ command_id, file_path }) => {
      try {
        // Command policy (cli-policy.ts): QuickAdd ids run arbitrary macros
        // the acceptance guard cannot inspect — denied by default, re-enabled
        // per-command only through the human-only settings. Same policy object
        // as obsidian_cli; refused BEFORE anything runs (including the
        // file_path open, which would leak an action for a refused command).
        const policyReason = runCommandRefusal(command_id, ctx.getSettings().cliPolicy);
        if (policyReason) {
          return codedError("cli_denied", policyReason);
        }
        if (file_path) {
          await app.workspace.openLinkText(file_path, "", false);
        }
        // app.commands is not in the public obsidian types — cast required.
        const executed = (app as any).commands.executeCommandById(command_id) as boolean | undefined;
        return ok({ command_id, executed: executed !== false });
      } catch (e) { return fail(e); }
    }
  );

  // ── obsidian_get_command_ids ────────────────────────────────────────────────
  server.registerTool(
    "obsidian_get_command_ids",
    {
      title: "Get command IDs",
      description: "List all registered Obsidian command IDs and names. Read-only.",
      inputSchema: {},
      annotations: RO,
    },
    async () => {
      try {
        // app.commands.commands is not in the public obsidian types — cast required.
        const commands = (app as any).commands.commands as Record<string, { name: string }>;
        const list = Object.entries(commands).map(([id, c]) => ({ id, name: c.name }));
        return ok({ count: list.length, commands: list });
      } catch (e) { return fail(e); }
    }
  );

  // ── obsidian_vault_info ─────────────────────────────────────────────────────
  server.registerTool(
    "obsidian_vault_info",
    {
      title: "Vault info",
      description: "Return vault metadata: name, base path, config dir, and attachment folder path. Read-only.",
      inputSchema: {},
      annotations: RO,
    },
    async () => {
      try {
        // app.vault.getConfig is not in the public obsidian types — cast required.
        const attachmentFolderPath = (app.vault as any).getConfig("attachmentFolderPath") as string | null;
        return ok({
          vault_name: app.vault.getName(),
          base_path: (app.vault.adapter as any).getBasePath?.() ?? null,
          config_dir: app.vault.configDir,
          attachment_folder_path: attachmentFolderPath ?? null,
        });
      } catch (e) { return fail(e); }
    }
  );

  // ── obsidian_tags_list ──────────────────────────────────────────────────────
  server.registerTool(
    "obsidian_tags_list",
    {
      title: "List all tags",
      description:
        "Return all tags in the vault with their usage counts, from the live metadata cache. Read-only. " +
        "While a path allowlist is active, only tags used by notes you can see are listed, and the counts are counts over those notes.",
      inputSchema: {},
      annotations: RO,
    },
    async () => {
      try {
        const settings = ctx.getSettings();
        if (!settings.allowlist.length) {
          // No boundary ⇒ the host's own aggregate, byte-identical to before.
          // getTags() is not in the public obsidian types — cast required.
          // Returns Record<string, number> where keys have a leading '#'.
          const raw = (app.metadataCache as any).getTags() as Record<string, number>;
          const tags = Object.entries(raw)
            .map(([tag, count]) => ({ tag, count }))
            .sort((a, b) => b.count - a.count);
          return ok({ count: tags.length, tags });
        }
        // Obsidian's getTags() aggregates the WHOLE vault, so a sandboxed
        // session would learn both the vocabulary of the area it is excluded
        // from and how much is in it — a tag name is often the most telling
        // thing about a note. Recompute over visible notes only; the aggregate
        // is not decomposable, so the only honest answer is to rebuild it.
        const files = app.vault.getMarkdownFiles();
        const shown = new Set(visiblePaths(files.map((f) => f.path), settings));
        const counts = new Map<string, number>();
        for (const f of files) {
          if (!shown.has(f.path)) continue;
          const cache = app.metadataCache.getFileCache(f);
          if (!cache) continue;
          for (const t of getAllTags(cache) ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
        }
        const tags = [...counts.entries()]
          .map(([tag, count]) => ({ tag, count }))
          .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
        return ok({ count: tags.length, tags });
      } catch (e) { return fail(e); }
    }
  );

  // ── obsidian_environment_info ───────────────────────────────────────────────
  server.registerTool(
    "obsidian_environment_info",
    {
      title: "Environment info",
      description: "Return Obsidian version, plugin version, platform, and list of enabled community plugins. Read-only.",
      inputSchema: {},
      annotations: RO,
    },
    async () => {
      try {
        // app.appVersion is not in the public obsidian types — cast required.
        return ok({
          obsidian_version: (app as any).appVersion as string,
          plugin_version: ctx.pluginVersion,
          platform: process.platform,
          enabled_plugins: ctx.enabledPlugins(),
        });
      } catch (e) { return fail(e); }
    }
  );
}

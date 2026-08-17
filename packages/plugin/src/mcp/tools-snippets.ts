// tools-snippets.ts — CSS snippet management over the LIVE app API
// (app.customCss), part of the obsidian_cli decomposition.
//
// The raw CLI proxy refuses `.obsidian` territory wholesale (configPathRefusal:
// plugin config and state must never be reachable through an agent surface).
// These four tools are the one CONSIDERED exception, and they are scoped to
// exactly `.obsidian/snippets/<name>.css` and nothing else:
//
//   - the snippet NAME is sanitized (snippetNameRefusal, fail closed) so it can
//     never carry a path separator or traverse out of the snippets folder — the
//     only file a write can touch is `<snippets folder>/<name>.css`, where the
//     folder comes from Obsidian's own customCss API (getSnippetsFolder);
//   - no other `.obsidian` file is readable or writable here: not data.json,
//     not appearance.json, not another plugin's directory. Enable/disable goes
//     through the app API (setCssEnabledStatus), never by editing config files;
//   - CSS is not frontmatter, so there is no accept surface to scan — but the
//     write tools are ordinary mutating registrations (readOnlyHint: false), so
//     they ride the guard-patched registrar: read-only mode blocks them, the
//     serialized queue orders them, and every write lands in the journal
//     (target.ref "name:<snippet>" via REF_KEYS).
//   - the MUTATING tools refuse while a path allowlist is active: a snippet is
//     vault-global config territory, not a note path the allowlist could scope.
//     The read tools stay available (snippet CSS is not note content and names
//     no note paths, so there is no note-tree oracle to leak).
//   - DECIDED, not unnoticed: a session that wrote a snippet may also ENABLE it
//     (write + toggle, no human gate between them). Enabled CSS shapes what the
//     app renders and can reference remote resources (url(...) in
//     @font-face/background-image), which is a different surface from a note
//     write. Under this repo's threat model (agents are fallible, not
//     adversarial — the rails catch honest mistakes) that is an accepted trade
//     for a working styling workflow: both calls are journaled, read-only mode
//     blocks both, and a human can disable any snippet in Settings → Appearance
//     at a glance. If a deployment wants a human gate here, read-only mode or
//     the path allowlist (which refuses both mutators) already provide one.
//
// Preferred over the CLI's snippet:enable/snippet:disable because we ARE inside
// Obsidian: the app API is direct, structured, and needs no subprocess. API
// surface verified against obsidian-typings (Obsidian 1.13.7): CustomCSS
// carries `snippets: string[]`, `enabledSnippets: Set<string>`,
// `setCssEnabledStatus(name, enabled)`, `readSnippets(reload?)`,
// `getSnippetsFolder()`, `requestLoadSnippets()`.
//
// Obsidian-free by construction, like tools-links.ts: everything arrives
// through the injected SnippetSource (structurally typed); the adapter
// (obsidianSnippetSource) is wired in server.ts.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ok, fail, codedError } from "./helpers.js";
import type { ServerCtx } from "./tools-core.js";

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
// Toggling sets an absolute state, so a repeat is a no-op.
const RW_TOGGLE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

// Conservative single-segment filename grammar: must START with a letter, digit,
// underscore or dash (no leading dot — never a hidden file), then letters,
// digits, spaces, dots, underscores, dashes. No `/` or `\` can match, so a name
// can never traverse out of the snippets folder ("a..b" is a harmless filename;
// a ".." SEGMENT would need a separator, which the grammar excludes).
const SNIPPET_NAME_RE = /^[A-Za-z0-9_-][A-Za-z0-9 ._-]{0,99}$/;

// Windows reserved device names: on Windows, `CON.css` (the reservation holds
// even with an extension) targets a device, not a file in the snippets folder —
// a crack in "confined to .obsidian/snippets/<name>.css" on that platform. The
// check is on the name's first dot-segment, case-insensitive.
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/**
 * The reason a snippet name is refused, or null when it is safe. Fail closed:
 * the name becomes the filename `<snippets folder>/<name>.css`, so anything
 * that could escape that shape — separators, a leading dot, a trailing dot or
 * space (filesystem-normalized on some platforms), an embedded extension — is
 * refused rather than normalized.
 */
export function snippetNameRefusal(name: string): string | null {
  if (typeof name !== "string" || name.length === 0) return "snippet name is empty";
  if (name.includes("/") || name.includes("\\")) {
    return `snippet name '${name}' contains a path separator — a snippet is a single file in the snippets folder`;
  }
  if (!SNIPPET_NAME_RE.test(name)) {
    return (
      `snippet name '${name}' is not a safe filename — use letters, digits, spaces, dots, underscores and dashes ` +
      `(must not start with a dot or space; max 100 chars)`
    );
  }
  if (name.endsWith(".") || name.endsWith(" ")) {
    return `snippet name '${name}' must not end with a dot or space`;
  }
  if (name.toLowerCase().endsWith(".css")) {
    return `snippet name '${name}' should not carry the .css extension — it is added automatically`;
  }
  if (WINDOWS_RESERVED_RE.test(name.split(".")[0])) {
    return `snippet name '${name}' is a reserved device name on Windows — pick another name`;
  }
  return null;
}

/** Everything the tools need, structurally typed so this module never imports
 * `obsidian` and is unit-testable headlessly. */
export interface SnippetSource {
  /** Vault-relative snippets folder (normally `.obsidian/snippets`). */
  folder(): string;
  /** Known snippets with their enabled state, from the live customCss API. */
  list(): Array<{ name: string; enabled: boolean }>;
  /** Whether `<folder>/<name>.css` exists on disk (authoritative — the live
   * list can lag a just-written file). */
  exists(name: string): Promise<boolean>;
  /** Read `<folder>/<name>.css`. */
  read(name: string): Promise<string>;
  /** Write `<folder>/<name>.css` (creating the folder if needed) and ask
   * Obsidian to re-read snippets so the new/updated file is picked up. */
  write(name: string, css: string): Promise<{ path: string; created: boolean }>;
  /** Enable/disable by name through the app API. */
  setEnabled(name: string, enabled: boolean): void;
}

/** The live adapter over `app.customCss` + the vault adapter. Structurally
 * typed — no `obsidian` import (the customCss surface is internal API anyway;
 * see the header comment for the obsidian-typings verification). */
export function obsidianSnippetSource(app: {
  vault: {
    configDir: string;
    adapter: {
      exists(path: string): Promise<boolean>;
      read(path: string): Promise<string>;
      write(path: string, data: string): Promise<void>;
      mkdir(path: string): Promise<void>;
    };
  };
  customCss?: {
    snippets?: string[];
    enabledSnippets?: Set<string>;
    setCssEnabledStatus?(name: string, enabled: boolean): void;
    readSnippets?(reload?: boolean): void;
    getSnippetsFolder?(): string;
    requestLoadSnippets?(): void;
  };
}): SnippetSource {
  const folder = (): string => {
    try {
      const f = app.customCss?.getSnippetsFolder?.();
      if (typeof f === "string" && f.length > 0) return f;
    } catch {
      // fall through to the conventional location
    }
    return `${app.vault.configDir}/snippets`;
  };
  const pathOf = (name: string) => `${folder()}/${name}.css`;
  return {
    folder,
    list() {
      const names = app.customCss?.snippets ?? [];
      const enabled = app.customCss?.enabledSnippets ?? new Set<string>();
      return names.map((name) => ({ name, enabled: enabled.has(name) }));
    },
    exists: (name) => app.vault.adapter.exists(pathOf(name)),
    read: (name) => app.vault.adapter.read(pathOf(name)),
    async write(name, css) {
      const dir = folder();
      if (!(await app.vault.adapter.exists(dir))) await app.vault.adapter.mkdir(dir);
      const path = pathOf(name);
      const created = !(await app.vault.adapter.exists(path));
      await app.vault.adapter.write(path, css);
      // Ask Obsidian to re-read the snippets folder so the file shows up in
      // customCss.snippets (and, if enabled, gets (re)applied).
      try {
        app.customCss?.readSnippets?.(true);
      } catch {
        // Non-fatal: the file is written; Obsidian re-reads on its own cadence.
      }
      return { path, created };
    },
    setEnabled(name, enabled) {
      const css = app.customCss;
      if (!css?.setCssEnabledStatus) {
        throw new Error("this Obsidian build exposes no snippet toggle API (customCss.setCssEnabledStatus)");
      }
      css.setCssEnabledStatus(name, enabled);
      // Debounced reload so the (dis)appearance takes effect promptly.
      try {
        css.requestLoadSnippets?.();
      } catch {
        // Non-fatal.
      }
    },
  };
}

export function registerSnippetTools(server: McpServer, ctx: ServerCtx, deps: { source: SnippetSource }) {
  const { source } = deps;

  // The mutating snippet tools cannot be path-scoped: a snippet is vault-global
  // config, not a note path. Under an active allowlist they refuse outright —
  // the obsidian_cli / unscopable-external-tool precedent.
  const allowlistRefusal = (tool: string) => {
    const settings = ctx.getSettings();
    if (settings.allowlist.length > 0) {
      return fail(
        `${tool} is disabled while a path allowlist is active: a CSS snippet is vault-global configuration and cannot be path-scoped.`
      );
    }
    return null;
  };

  server.registerTool(
    "obsidian_snippets_list",
    {
      title: "List CSS snippets",
      description:
        "List the vault's CSS snippets with their enabled state, from Obsidian's live customCss registry. Read-only. " +
        "Snippets live in `.obsidian/snippets/*.css` — the ONLY `.obsidian` territory the snippet tools touch.",
      inputSchema: {},
      annotations: RO,
    },
    async () => {
      try {
        return ok({ folder: source.folder(), snippets: source.list() });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "obsidian_snippet_read",
    {
      title: "Read a CSS snippet",
      description:
        "Read one CSS snippet's text (`.obsidian/snippets/<name>.css` — the ONLY `.obsidian` territory the snippet " +
        "tools touch). Read-only.",
      inputSchema: {
        name: z.string().min(1).describe("Snippet name (filename without .css), from obsidian_snippets_list."),
      },
      annotations: RO,
    },
    async (args: { name: string }) => {
      try {
        const nameReason = snippetNameRefusal(args.name);
        if (nameReason) return codedError("invalid_snippet_name", nameReason);
        if (!(await source.exists(args.name))) {
          return codedError("snippet_not_found", `no snippet named '${args.name}' (looked for ${source.folder()}/${args.name}.css)`);
        }
        const enabled = source.list().find((s) => s.name === args.name)?.enabled ?? false;
        return ok({ name: args.name, enabled, css: await source.read(args.name) });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "obsidian_snippet_write",
    {
      title: "Create or update a CSS snippet",
      description:
        "Create or overwrite one CSS snippet by name. Writes ONLY `.obsidian/snippets/<name>.css` — the one " +
        "considered exception to the rule that agent surfaces never touch `.obsidian` territory; the name is " +
        "sanitized so it cannot escape that folder or reach any other config file. Mutating (queue + journal; " +
        "blocked in read-only mode); refuses while a path allowlist is active. A new snippet starts DISABLED — " +
        "enable it with obsidian_snippet_toggle.",
      inputSchema: {
        name: z
          .string()
          .min(1)
          .describe("Snippet name (filename without .css). Letters, digits, spaces, dots, underscores, dashes."),
        css: z.string().max(1_000_000).describe("The full CSS text for the snippet (replaces any existing content)."),
      },
      annotations: RW,
    },
    async (args: { name: string; css: string }) => {
      try {
        const blocked = allowlistRefusal("obsidian_snippet_write");
        if (blocked) return blocked;
        const nameReason = snippetNameRefusal(args.name);
        if (nameReason) return codedError("invalid_snippet_name", nameReason);
        const { path, created } = await source.write(args.name, args.css);
        return ok({ name: args.name, path, created, bytes: args.css.length });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "obsidian_snippet_toggle",
    {
      title: "Enable or disable a CSS snippet",
      description:
        "Enable or disable one CSS snippet by name, through Obsidian's own customCss API (never by editing config " +
        "files — `.obsidian/snippets/*.css` is the only `.obsidian` territory the snippet tools touch, and this tool " +
        "touches no file at all). Mutating (journaled; blocked in read-only mode); refuses while a path allowlist is " +
        "active.",
      inputSchema: {
        name: z.string().min(1).describe("Snippet name (filename without .css), from obsidian_snippets_list."),
        enabled: z.boolean().describe("true to enable, false to disable."),
      },
      annotations: RW_TOGGLE,
    },
    async (args: { name: string; enabled: boolean }) => {
      try {
        const blocked = allowlistRefusal("obsidian_snippet_toggle");
        if (blocked) return blocked;
        const nameReason = snippetNameRefusal(args.name);
        if (nameReason) return codedError("invalid_snippet_name", nameReason);
        // Existence is checked on DISK, not the live list — a snippet written a
        // moment ago may not be in customCss.snippets yet (readSnippets is
        // debounced/async), and the disk is what Obsidian will re-read.
        if (!(await source.exists(args.name))) {
          return codedError("snippet_not_found", `no snippet named '${args.name}' (looked for ${source.folder()}/${args.name}.css)`);
        }
        source.setEnabled(args.name, args.enabled);
        return ok({ name: args.name, enabled: args.enabled });
      } catch (e) {
        return fail(e);
      }
    }
  );
}

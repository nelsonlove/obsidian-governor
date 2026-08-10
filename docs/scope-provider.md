# Scope provider — `jd:` addressing (read-only)

The scope provider is a [capability module](modules.md) (id `scheme`, capabilities
`["addressing", "allocation"]`) that gives an agent a **scheme-relative** way to name and place
notes. The default configured scheme is **Johnny Decimal**, addressed `jd:`.

Files: `packages/plugin/src/mcp/tools-scheme.ts` (tools), `packages/plugin/src/kernel/scheme/`
(the pure engine: `registry.ts`, `jd.ts`, `provider.ts`, `findings.ts`). Everything here is
**read-only** — nothing in the module mutates a note, and the module is Obsidian-import-free
(headlessly testable).

## `jd:` as a path address

Beside `uid:`, a path argument also accepts `<scheme>:<address>` — for the default
configuration, **`jd:06.11`**. It resolves at the same interception point as uid addressing,
**immediately after it** (`uid:` is reserved and always gets first look), so a call can freely
mix the two:

```jsonc
{"path": "jd:06.11", "content": "…"}                    // obsidian_write_note
{"from": "jd:06.11", "to": "jd:06.12"}                   // any path argument
```

Resolution runs over **allowlist-visible notes only** (`registry.ts`, wired at `guarded.ts`), so
it sees exactly the candidates `obsidian_resolve_address` would report:

- `Error [address_unresolved]` — no note *you can reach* carries the address (even if a hidden
  note does).
- `Error [address_ambiguous]` — two or more visible notes claim it; the error names only the
  candidates you could have named yourself (capped at 10).

`jd` is the **id** of the default Johnny-Decimal instance, not a hardwired prefix:
`DEFAULT_SCHEMES = [{ id: "jd", provider: "johnny-decimal" }]`, configurable via the top-level
`schemes` setting. The ref grammar is `<scheme-id>:<address>`; `uid:` is explicitly never
treated as a scheme ref.

## The five tools

All read-only (`readOnlyHint: true`), registered through the module registry (which enforces
the read-only mount gate).

| Tool | Input | Returns |
| --- | --- | --- |
| **`obsidian_schemes`** | *(none)* | `{ schemes: [{ id, provider, capabilities, config, examples }] }` — every configured instance, its capabilities, the config override in effect, and a couple of example addresses in its own grammar (e.g. `jd:06.11`). |
| **`obsidian_resolve_address`** | `address?` **xor** `path?` | address → `{ address, found, path, duplicates?, ambiguous? }` or `{ found:false, parsed:{kind,levels} }`; path → `{ path, address, scheme }`. Reports duplicates; never picks or repairs. |
| **`obsidian_next_address`** | `scope` (e.g. `"06"`), `scheme?` | `{ scope, next, exhausted, allocatable, hint? }` — the next free address in that scope. **Compute-only.** |
| **`obsidian_list_scope`** | `scope`, `scheme?` | `{ scope, members:[{address,path}], free:{ next, gaps, truncated, allocatable, hint? } }` — members in address order plus up to 20 open slots (`free.truncated:true` when more exist). |
| **`obsidian_expected_location`** | `path?` **xor** `address?`, `scheme?` | `{ address, expected_folder, actual_folder, placed }` — where the scheme says it belongs, and whether it's there. |

### Error codes

- **`invalid_scope`** (coded) — a scope token that doesn't parse, from `obsidian_next_address`
  and `obsidian_list_scope`.
- **`address_unresolved`** / **`address_ambiguous`** — thrown by the addressing layer
  (`registry.ts`) during universal `jd:` path-argument rewriting, rendered as typed tool errors.
- Argument-shape refusals (both/neither of `address`/`path`, no scheme configured, multiple
  instances with no `scheme` specified, unknown scheme id) are **uncoded** `Error: …` messages.

Allowlist filtering in the scope tools is **silent** — a hidden note simply reads as not-found,
so there is no existence oracle for territory a session is sandboxed out of.

## Allocation computes, it does not reserve

`obsidian_next_address` and `obsidian_list_scope`'s free-slot answers are **computed, never
reserved**. Straight from the module's own header:

> Nothing here mutates anything. `obsidian_next_address` in particular only **computes** — the
> actual exclusivity story is `obsidian_claim_scope` … two sessions racing this tool can compute
> the identical answer, and only a claim (or the note actually landing) settles who gets it.

So the tool's answer holds only until a note actually lands there. For exclusivity while you
create the note, pair it with an [advisory scope claim](kernel-v0.md#advisory-scope-locks--ttl).
Under an allowlist, a hidden note can hold a slot these tools report as free — "next free" is
only ever free among what your session can see.

## Johnny Decimal grammar (the default provider)

`jd.ts` recognizes: `area` (`00-09`), `category` (`06`), `id` (`06.11` / `06.110`),
`expanded-item` (`92021` / `27001`), and `fractal-id` (`92021.10`). Its capabilities are
`{ validate, itemAddresses, allocate, ordered }`. Content decimals start at a configurable floor
(default `.10` — `.00–.09` reserved as standard zeros). Default config expands the `90-99` area
and the `27` category. `allocatable(scope)` returns `{ allocatable:false, hint }` for scopes that
can't take a fresh content id (plain areas, expanded-items, categories folded into an expanded
band) — distinct from a fully allocatable scope.

## Conformance findings (not a tool)

`packages/plugin/src/kernel/scheme/findings.ts` is a scheme-conformance rule-pack (finding codes
`misfiled`, `duplicate_address`, `malformed_name`, `unaddressed`) that is deliberately **not
registered as a tool** — capabilities arrive as rule packs, not as new mutating surface. It is
available to future review/rail surfaces, not to agents as a write path.
</content>

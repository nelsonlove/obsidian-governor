#!/usr/bin/env bash
# block-record-writes.sh — PreToolUse hook for Bash and mcp__(vault-mcp|governor)__* tools.
#
# BOTH id prefixes are matched, deliberately. The plugin id was `vault-mcp`
# before 0.12.0, is `governor` today, and the suite split returns the HOST to
# `vault-mcp` — so a single-prefix match silently stops guarding on every
# rename. It already did: this hook matched only `mcp__vault-mcp__*` from the
# 0.12.0 rename until 2026-08-29, which means it never fired for any MCP tool
# call in that whole window. The Bash half was unaffected.
#
# Guards record-class files — the byte-verbatim, write-once fold archives under
# any "Machinery record/" folder — against the write paths a plain Edit/Write
# guard cannot see:
#
#   1. Bash-mediated writes: truncating redirects (`>`, `&>`), `tee` without
#      -a/--append, `sed -i`, and destructive `mv`/`rm`/`trash` whose target
#      mentions the record folder. Appends (`>>`, `&>>`, `tee -a`) pass —
#      dated record entries are appends. Heredoc bodies are stripped before
#      matching, so an appended entry may safely *mention* the folder or
#      contain `>` blockquote lines.
#   2. vault-mcp mutating tools (write_note, patch_note, manage_frontmatter,
#      delete/trash/move/refile/renumber, append_at_heading, …) whose input
#      references a record path. Only obsidian_append_note passes.
#
# HONEST LIMITS (threat model: fallible agents, not adversaries): a command
# that builds the path in a variable, cd's into the folder, or writes from an
# inline python/perl script is not caught — static detection of "will this
# command write file X" is undecidable. The durable layer is server-side
# enforcement of `record: true` in vault-mcp itself; this hook narrows the
# window until that ships.
#
# On match: exit 2 with a corrective message on stderr.

input=$(cat)

command -v jq >/dev/null 2>&1 || {
    echo "[block-record-writes] jq not found on PATH — record write guard DISABLED for this call" >&2
    exit 0
}

tool=$(jq -r '.tool_name // empty' <<<"$input")

MARKER="Machinery record"

corrective() {
    cat >&2 <<EOF
BLOCKED: this $1 would mutate a record-class file (under '$MARKER/').
Record folds are byte-verbatim and write-once; the only permitted change is
APPENDING a dated entry at end of file:

cat <<'EOF_ENTRY' >> '<record file path>'

---

## $(date '+%Y-%m-%d') — <title>

<your entry — never modify text between %% fold %% markers>
EOF_ENTRY

(vault-mcp obsidian_append_note is equally fine.) Reading rules: the
'Machinery record' spine note. If you believe this block is wrong, say so to
the human rather than working around it.
EOF
    exit 2
}

# Remove heredoc bodies: from a line containing <<[-]['"]DELIM to the line that
# is exactly DELIM (optionally indented, for <<-). Heredoc bodies are data fed
# to a command, not commands — matching inside them yields false positives
# (e.g. a '>' blockquote line naming the marker inside a sanctioned append).
# The introducing line, which carries any real redirect, is kept.
strip_heredocs() {
    awk '
        skip != "" {
            line = $0
            sub(/^[[:space:]]+/, "", line)
            if (line == skip) { skip = "" }
            next
        }
        {
            print
            # Probe copy with here-strings (<<<) and arithmetic expansions
            # ($((...)), which may contain << shifts) neutralized, so neither
            # is mistaken for a heredoc opener (which would eat real commands).
            probe = $0
            gsub(/\$\(\([^)]*\)\)/, "ARITH", probe)
            gsub(/<<</, "HSTR", probe)
            if (match(probe, /<<-?[[:space:]]*['\''"]?[A-Za-z_][A-Za-z_0-9]*/)) {
                d = substr(probe, RSTART, RLENGTH)
                sub(/^<<-?[[:space:]]*['\''"]?/, "", d)
                skip = d
            }
        }
    '
}

case "$tool" in
    Bash)
        cmd=$(jq -r '.tool_input.command // empty' <<<"$input")
        [ -n "$cmd" ] || exit 0
        stripped=$(strip_heredocs <<<"$cmd")
        case "$stripped" in
            *"$MARKER"*) ;;
            *) exit 0 ;;
        esac
        # Truncating stdout redirect. Target run excludes quotes and & so it
        # can cross neither a quoting boundary nor a `2>&1`-style dup.
        if grep -Eq "(^|[^>&])>\|?[[:space:]]*['\"]?[^'\">&]*$MARKER" <<<"$stripped"; then
            corrective "shell redirect (truncating '>')"
        fi
        # Truncating stdout+stderr redirect: `&>` (but not `&>>`).
        if grep -Eq "(^|[[:space:]])&>[[:space:]]*['\"]?[^'\">&]*$MARKER" <<<"$stripped"; then
            corrective "shell redirect (truncating '&>')"
        fi
        # tee without append. First erase tee invocations that carry -a or
        # --append, then any tee still reaching the marker is truncating.
        noappend=$(sed -E 's/(^|[[:space:]|;&(])tee[[:space:]]+((-[[:alnum:]]*a[[:alnum:]]*|--append)([[:space:]]+|$))+/\1TEE_APPEND /g' <<<"$stripped")
        if grep -Eq "\btee([[:space:]]+-[^[:space:]]+)*[[:space:]]+['\"]?[^|;&'\"]*$MARKER" <<<"$noappend"; then
            corrective "tee without -a/--append"
        fi
        if grep -Eq "\bsed[[:space:]]+(-[[:alnum:]]+[[:space:]]+)*-i[^[:space:]]*[[:space:]][^|;]*$MARKER" <<<"$stripped"; then
            corrective "in-place sed"
        fi
        # Destructive/overwriting ops (incl. cp INTO a record), anchored to
        # command position so '-rm'/'--rm' never fire; the argument tail may
        # cross quotes (any mention in a mv/cp/rm argument list blocks) but
        # not |;& — command separators end the tail.
        if grep -Eq "(^|[|;&()[:space:]])(mv|cp|rm|trash|/usr/bin/trash)[[:space:]]+[^|;&]*$MARKER" <<<"$stripped"; then
            corrective "destructive file operation (mv/rm/trash)"
        fi
        exit 0
        ;;
    mcp__vault-mcp__obsidian_append_note|mcp__governor__obsidian_append_note)
        exit 0
        ;;
    mcp__vault-mcp__obsidian_call_tool|mcp__governor__obsidian_call_tool)
        # Code Mode tunnels every call through obsidian_call_tool — apply the
        # same policy to the INNER tool name.
        inner=$(jq -r '.tool_input.name // empty' <<<"$input")
        case "$inner" in
            obsidian_append_note) exit 0 ;;
            *read*|*search*|*list*|*get_*|*find_*|*check_links*|*resolve*|*note_history*|*note_diff*|*jump_to*|*open_*|*doctor*|*info*|*tags_list*|*conformance*|*pending_review*)
                exit 0 ;;
        esac
        args=$(jq -r '.tool_input | tostring' <<<"$input")
        case "$args" in
            *"$MARKER"*) corrective "vault-mcp mutation via Code Mode ($inner)" ;;
            *) exit 0 ;;
        esac
        ;;
    mcp__vault-mcp__*|mcp__governor__*)
        case "$tool" in
            *read*|*search*|*list*|*get_*|*find_*|*check_links*|*resolve*|*note_history*|*note_diff*|*jump_to*|*open_*|*doctor*|*info*|*tags_list*|*conformance*|*pending_review*)
                exit 0 ;;
        esac
        args=$(jq -r '.tool_input | tostring' <<<"$input")
        case "$args" in
            *"$MARKER"*) corrective "vault-mcp mutation ($tool)" ;;
            *) exit 0 ;;
        esac
        ;;
    *)
        exit 0
        ;;
esac

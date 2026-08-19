#!/bin/sh
# Git clean filter: strip a leading YAML frontmatter block from stdin.
#
# Why: README.md is symlinked into the Obsidian vault, where vault machinery
# (the Linter, fileclass stamps) adds YAML frontmatter to any note it sees.
# This filter runs when git READS the file (staging, diff, status), so the
# committed blob never contains frontmatter and git sees the working file as
# unmodified however much frontmatter the vault side accretes. The smudge
# direction is a pass-through (no smudge configured): frontmatter simply lives
# only in the working copy, where the vault is welcome to it.
#
# One-time setup per clone (documented in docs/README.md):
#   git config filter.stripfm.clean "sh scripts/strip-frontmatter.sh"
#
# A clone WITHOUT the config still works: the committed content is already
# clean, and gitattributes' `filter=` is a no-op when the filter is undefined.
#
# Semantics: a block is stripped only when line 1 is exactly `---`; everything
# through the next `---` (or `...`) line goes, plus AT MOST ONE blank line
# directly after the closing fence (Obsidian writers usually leave one, and the
# un-frontmattered original does not start blank). Anything else passes through.
awk '
  NR == 1 && $0 == "---" { infm = 1; next }
  infm && ($0 == "---" || $0 == "...") { infm = 0; justclosed = 1; next }
  infm { next }
  justclosed && $0 == "" { justclosed = 0; next }
  { justclosed = 0; print }
'
#!/bin/sh
# Point this clone's git at the repo's tracked hooks.
#
# Run once per clone:  ./scripts/install-hooks.sh
#
# Git deliberately does not run hooks from a cloned repo automatically — a repo
# that could install its own executable code on checkout would be a supply-chain
# hole. So this is manual by design, and worth the ten seconds.
set -e
cd "$(git rev-parse --show-toplevel)"
git config core.hooksPath .githooks
chmod +x .githooks/* 2>/dev/null || true
echo "hooks installed: core.hooksPath -> .githooks"
echo
echo "Active hooks:"
for h in .githooks/*; do
  [ -f "$h" ] && echo "  $(basename "$h")"
done
echo
echo "Verify the secret scan is live with:"
echo "  printf 'x' | node scripts/secret-scan.mjs   # exits 0 on clean input"

#!/usr/bin/env bash
# One-time setup: copies gstack git hooks from .claude/hooks/git/ into .git/hooks/.
# Run once after cloning: bash scripts/install-hooks.sh

set -e
REPO_ROOT="$(git rev-parse --show-toplevel)"

for hook in pre-commit pre-push post-merge; do
  SRC="$REPO_ROOT/.claude/hooks/git/$hook"
  DST="$REPO_ROOT/.git/hooks/$hook"
  if [ ! -f "$SRC" ]; then
    echo "SKIP: $SRC not found"
    continue
  fi
  cp "$SRC" "$DST"
  chmod +x "$DST"
  echo "Installed: .git/hooks/$hook"
done

echo ""
echo "All gstack git hooks installed."
echo "Hooks active: pre-commit (typecheck), pre-push (review/cso/ship reminders), post-merge (docs reminder)"

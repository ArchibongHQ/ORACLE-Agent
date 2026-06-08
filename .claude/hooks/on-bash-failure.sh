#!/usr/bin/env bash
# Reads PostToolUse result JSON from stdin; suggests /gstack-investigate on failure.
INPUT=$(cat)
EXIT_CODE=$(echo "$INPUT" | python3 -c \
  "import sys, json; d=json.load(sys.stdin); print(d.get('exit_code', 0))" \
  2>/dev/null || echo "0")
if [ "$EXIT_CODE" != "0" ] && [ "$EXIT_CODE" != "" ]; then
  echo "SUGGESTION: Bash command exited $EXIT_CODE."
  echo "If this failure has persisted 2+ attempts, invoke /gstack-investigate for root-cause analysis."
fi

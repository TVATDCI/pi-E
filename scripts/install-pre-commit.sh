#!/bin/bash
# install-pre-commit.sh — #5 local CI: installs a pre-commit hook that runs the
# unified test runner (scripts/run-tests.ts) before every commit.
#
# Idempotent: safe to re-run; replaces any hook we previously installed
# (marked with our signature). A pre-existing UNMARKED hook is preserved —
# ours is appended after it, and you're told.
#
# Escape hatch: SKIP_TESTS=1 git commit ...   (hotfix commits)
# Uninstall:   rm .git/hooks/pre-commit   (or remove our marked block)

set -euo pipefail
cd "$(dirname "$0")/.."
HOOK=".git/hooks/pre-commit"
MARKER="# --- pi-agent test gate (run-tests) ---"
BODY='node --experimental-strip-types scripts/run-tests.ts'

if [ ! -d .git ]; then
  echo "no .git here — run from the repo" >&2
  exit 1
fi

if [ -f "$HOOK" ] && grep -q "$MARKER" "$HOOK"; then
  # ours already present: strip old block, re-append (keeps it fresh)
  awk -v m="$MARKER" 'index($0,m)==1{skip=1;next} skip&&/^$/{skip=0;next} !skip' "$HOOK" > "$HOOK.tmp" || true
  mv "$HOOK.tmp" "$HOOK"
  echo "existing pi-agent gate refreshed"
fi

{
  if [ -s "$HOOK" ]; then
    if ! tail -n1 "$HOOK" | grep -q '^$'; then echo ""; fi
  fi
  echo "$MARKER"
  echo "[ \"\$SKIP_TESTS\" = \"1\" ] && exit 0"
  echo "$BODY"
  echo "exit \$?"
} >> "$HOOK"

chmod +x "$HOOK"
echo "installed: $HOOK -> $BODY"
echo "escape hatch: SKIP_TESTS=1 git commit ..."

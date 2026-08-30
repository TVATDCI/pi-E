#!/bin/bash
# bootstrap.sh — #10a self-portability bootstrap for the pi agent repo (~/.pi/agent).
#
# Fresh machine: git clone → (copy state files — see PORTABILITY.md) → bash scripts/bootstrap.sh
#
# What it does:
#   1. READ-ONLY environment checks (node >= 22.6, pi on PATH, git, w3m warn-only,
#      repo-shape sanity) — each ✓ or ⚠ with a remediation hint.
#   2. Installs pinned extension dependencies from package.json (Oracle condition
#      2026-08-30: yaml/minimatch/typebox — pi bundles them only in some versions;
#      pinned + lockfile'd, verified on Arch/Omarchy).
#   3. ONE optional write action: installing the pre-commit test gate (prompts y/n;
#      delegates to scripts/install-pre-commit.sh).
#   4. Prints the state-file checklist (what to copy from the old machine) and the
#      restore-verification command.
#
# Never echoes file contents (secrets stay unread), never writes outside the offer.

set -euo pipefail
cd "$(dirname "$0")/.."

pass=0; warn=0; fail=0
ok()   { echo "  ✓ $1"; pass=$((pass+1)); }
warned() { echo "  ⚠ $1"; warn=$((warn+1)); }
bad()  { echo "  ✗ $1  → $2"; fail=$((fail+1)); }

echo "== pi agent bootstrap =="
echo "repo: $(pwd)"
echo

echo "-- system dependencies --"
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  NODE_MINOR=$(node -p 'process.versions.node.split(".")[1]' 2>/dev/null || echo 0)
  if [ "$NODE_MAJOR" -gt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -ge 6 ]; }; then
    ok "node $(node --version) (>= 22.6 for --experimental-strip-types)"
  else
    bad "node $(node --version) is < 22.6" "upgrade node (nvm install 22)"
  fi
else
  bad "node not found" "install node >= 22.6 (https://nodejs.org or nvm)"
fi

if command -v pi >/dev/null 2>&1; then
  ok "pi on PATH ($(command -v pi))"
  pi --version 2>/dev/null | head -1 | sed 's/^/    /' || true
else
  bad "pi not on PATH" "npm install -g @earendil-works/pi-coding-agent"
fi

if command -v git >/dev/null 2>&1; then ok "git $(git --version | cut -d' ' -f3)"; else bad "git not found" "install git"; fi

if command -v w3m >/dev/null 2>&1; then
  ok "w3m present (web-research fetch/extraction)"
else
  warned "w3m missing — only web-research extension needs it (apt-get install w3m / brew install w3m)"
fi
echo

echo "-- repo shape (am I in the right place?) --"
[ -d extensions ] && ok "extensions/ present" || bad "extensions/ missing" "run from the pi agent repo root"
[ -f agent-chain.yaml ] && ok "agent-chain.yaml present" || warned "agent-chain.yaml missing (chains unavailable)"
[ -f models.json ] && ok "models.json present" || warned "models.json missing (model pins unavailable)"
[ -f mini-dc-rules.yaml ] && ok "mini-dc-rules.yaml present" || bad "mini-dc-rules.yaml missing (safety gate rules)"
[ -d skills ] && ok "skills/ ($(ls skills 2>/dev/null | wc -l | tr -d ' ') skills)" || bad "skills/ missing"
echo

echo "-- state files (copy from old machine — see PORTABILITY.md) --"
check_state() {
  # $1 path, $2 importance, $3 note
  if [ -e "$1" ]; then ok "$1 present"; else
    if [ "$2" = "required" ]; then bad "$1 MISSING" "$3"; else warned "$1 missing — $3"; fi
  fi
}
check_state auth.json            required  "provider keys — copy from old machine (NEVER commit)"
check_state settings.json        optional  "defaults (provider/model/theme); copy or recreate in pi settings"
check_state memory/store.jsonl   required  "structured memory (agent self-model); copy from old machine"
check_state memory.md            optional  "narrative memory log; copy if you want the arc"
echo

echo "-- extension dependencies (pinned, per package.json) --"
if [ -f package.json ]; then
    if npm install --no-audit --no-fund >/dev/null 2>&1; then
        ok "pinned deps installed (yaml/minimatch/typebox + lockfile record)"
    else
        warned "npm install failed — extensions may report missing packages; retry manually"
    fi
else
    warned "no package.json at repo root — skipping pinned deps"
fi

echo "-- pre-commit test gate --"
if [ -f .git/hooks/pre-commit ] && grep -q "pi-agent test gate" .git/hooks/pre-commit 2>/dev/null; then
  ok "already installed"
else
  printf "  install pre-commit hook (runs the 30-file test suite on every commit)? [y/N] "
  # EOF-safe: works piped (printf | bootstrap), interactive, AND tty-less contexts;
  # `|| answer=n` survives EOF/failed read instead of dying under set -e (V2 lesson).
  read -r answer || answer="n"
  if [ "$answer" = "y" ] || [ "$answer" = "Y" ]; then
    bash scripts/install-pre-commit.sh
  else
    echo "  skipped (install later: bash scripts/install-pre-commit.sh)"
  fi
fi
echo

echo "== summary: $pass ok, $warn warnings, $fail failures =="
if [ "$fail" -gt 0 ]; then
  echo "   fix ✗ items above, then re-run."
  exit 1
fi
echo "   restore verification: node --experimental-strip-types scripts/run-tests.ts --expect 31"
echo "   (31/31 green = repo restored; first live model call verifies auth.json)"

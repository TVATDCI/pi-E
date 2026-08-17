#!/usr/bin/env bash
# stack-health.sh — pi-side umbrella health check (Oracle top-3 item #2, verdict dd-v0.2)
# Detects the silent failure modes: bridge-cron rot, unpushed-work pileup,
# ghost-class untracked files, stale /tmp lane dirs. Read-only — reports, never fixes.
# Run: on demand, or at session-begin for a quick pre-flight.

set -u  # intentional: no -e/-pipefail; a health check must report ALL checks, not abort on first failure
RED='\033[0;31m'; YEL='\033[1;33m'; GRN='\033[0;32m'; RST='\033[0m'
fail=0

echo "== pi stack health ($(date '+%F %T')) =="

# 1. Bridge export freshness (hourly cron; stale = cron dead or BEADS_DIR regression)
BRIDGE="$HOME/.pi/agent/bridge/global-export.jsonl"
if [ -f "$BRIDGE" ]; then
  age_h=$(( ( $(date +%s) - $(stat -c %Y "$BRIDGE") ) / 3600 ))
  if [ "$age_h" -gt 25 ]; then
    echo -e "${RED}FAIL${RST} bridge export ${age_h}h old (cron dead?) — check bridge/cron.log"
    tail -3 "$HOME/.pi/agent/bridge/cron.log" 2>/dev/null
    fail=1
  else
    echo -e "${GRN}OK${RST}   bridge export fresh (${age_h}h old)"
  fi
else
  echo -e "${RED}FAIL${RST} bridge export missing entirely"
  fail=1
fi

# 2. Unpushed commits (pi repo; norm-accepted but pileup should be visible)
cd "$HOME/.pi/agent" 2>/dev/null || { echo -e "${RED}FAIL${RST} no pi agent dir"; exit 1; }
unpushed=$(git log origin/main..HEAD --oneline 2>/dev/null | wc -l)
if [ "$unpushed" -gt 0 ]; then
  echo -e "${YEL}WARN${RST} pi repo: ${unpushed} unpushed commit(s) (operator-only push — accepted, keep visible)"
else
  echo -e "${GRN}OK${RST}   pi repo pushed"
fi

# 3. Ghost sweep — untracked files that are NOT known runtime-state (ghost-class detector).
# exports/* and sessions/* are tracked-dir additions (commit-pending work, not ghosts).
ghosts=$(git status --porcelain | grep '^??' | awk '{print $2}')
ghost_count=0
for g in $ghosts; do
  case "$g" in
    exports/*|sessions/*|*.log|*.tmp|mcp-cache.json|mcp-onboarding.json|extensions/quotas.json) ;; # known/tracked-dir/runtime-state
    *) echo -e "${RED}FAIL${RST} ghost untracked: $g (unexpected file — investigate before deleting)"; ghost_count=$((ghost_count+1));;
  esac
done
[ "$ghost_count" -gt 0 ] && fail=1
[ "$ghost_count" -eq 0 ] && echo -e "${GRN}OK${RST}   ghost sweep clean"

# 4. Stale /tmp lane dirs (lane-close discipline)
for d in /tmp/herdr-collab/*/; do
  [ -d "$d" ] || continue
  age_h=$(( ( $(date +%s) - $(stat -c %Y "$d") ) / 3600 ))
  if [ "$age_h" -gt 24 ]; then
    echo -e "${YEL}WARN${RST} stale lane dir ${d} (${age_h}h old) — archive to exports/ then remove"
  fi
done

# 5. Modified-not-staged pileup (uncommitted work drifting)
dirty=$(git status --porcelain | grep -c '^ M')
[ "$dirty" -gt 0 ] && echo -e "${YEL}WARN${RST} ${dirty} modified-uncommitted file(s) in pi repo"

echo "== done =="
exit $fail

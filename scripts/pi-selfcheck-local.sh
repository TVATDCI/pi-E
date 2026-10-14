#!/usr/bin/env bash
# pi-selfcheck-local.sh — pi-E stack hook for the fleet pi-selfcheck (converged spec 2026-10-14).
#
# The dotfiles pi-selfcheck.sh (pi-the-PRODUCT contract) invokes this hook IFF present+executable
# at ~/.pi/agent/scripts/pi-selfcheck-local.sh and folds its lines AND exit code into its summary.
# Missing hook = SKIP on the fleet side (bare install stays green) — never a FAIL there.
#
# Scope (converged boundary c + round table a): everything STACK-specific —
#   1. scripts/stack-health.sh      — invoked, output folded, exit folded (no re-implementation).
#   2. scripts/run-tests.ts         — the extension suite (behavioral authority: bridge composition,
#                                     sentinel, purpose/task gates, memory chain); tail + exit folded.
#   3. File-level checks (live desk):
#        bridge/global-export.jsonl — exists, every line JSONL-parses, mtime < 25h
#        memory/store.jsonl         — last line JSON-parses
#        ~/lane-inbox               — unread root *.md counted, reported INFO (read-only; the hook
#                                     NEVER writes a canary/injection file — round-forbidden)
#
# Contract: invoked with no arguments; human lines prefixed '[stack]' with PASS/FAIL/INFO;
# final line one JSON object {"<check>":"<status>",...,"exit":N}; exit 0 only if zero FAILs;
# TIMEOUT (suite over budget) is reported as FAIL with a run-it-manually hint.
# Write surface: NOTHING outside selfcheck_-prefixed /tmp scratch (self-cleaned in the same run).
# Read-only everywhere else. Data paths are the LIVE desk's ~/.pi/agent (same convention
# stack-health.sh uses); sibling scripts resolve from this script's own install root.
#
# Run: ~/.pi/agent/scripts/pi-selfcheck-local.sh   (no args)

set -u  # intentional: no -e — a selfcheck must report ALL checks, not abort on the first failure

SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
ROOT="$(dirname "$(dirname "$SCRIPT_PATH")")"   # scripts/<hook> -> repo / install root
PI_HOME="${HOME}/.pi/agent"                     # live desk data (matches stack-health.sh convention)
SUITE_BUDGET=480                                # seconds — suite is the long pole; <10 min total contract
SH_BUDGET=60                                    # stack-health is file ops + git; generous but bounded

fails=0
json_keys=()

emit() { # emit <status> <label> [detail]
  local status="$1" label="$2" detail="${3:-}"
  printf '[stack] %-4s %s%s\n' "$status" "$label" "${detail:+ — $detail}"
  json_keys+=("\"${label}\":\"${status}\"")
}

pass() { emit PASS "$1" "${2:-}"; }
info() { emit INFO "$1" "${2:-}"; }

fail() { # fail <label> <detail-with-HINT>
  emit FAIL "$1" "$2"
  fails=$((fails + 1))
}

fold_lines() { # fold_lines <text> — reprint captured output, one '[stack] '-prefixed line per line
  local l
  while IFS= read -r l; do printf '[stack] %s\n' "$l"; done <<<"$1"
}

strip_ansi() { sed -e 's/\x1b\[[0-9;]*m//g'; }

SUITE_TMP="$(mktemp /tmp/selfcheck_suite_XXXXXX 2>/dev/null)" || SUITE_TMP=""
trap 'rm -f "$SUITE_TMP"' EXIT

# ---------------------------------------------------------------- 1. stack-health.sh
if [ -x "$ROOT/scripts/stack-health.sh" ]; then
  sh_out="$(timeout "$SH_BUDGET" "$ROOT/scripts/stack-health.sh" 2>&1 | strip_ansi)"
  sh_rc="${PIPESTATUS[0]}"
  fold_lines "$sh_out"
  if [ "$sh_rc" -eq 0 ]; then
    pass "stack-health"
  else
    fail "stack-health" "see its FAIL lines above (hint: address them before re-running the selfcheck)"
  fi
else
  fail "stack-health" "not found/executable at $ROOT/scripts/stack-health.sh (hint: pi-E install incomplete)"
fi

# ------------------------------------------------- 2. bridge/global-export.jsonl (live)
bf="$PI_HOME/bridge/global-export.jsonl"
if [ ! -f "$bf" ]; then
  fail "bridge-export" "missing at $bf (hint: bridge cron dead? check $PI_HOME/bridge/cron.log)"
else
  age_h=$(( ( $(date +%s) - $(stat -c %Y "$bf") ) / 3600 ))
  if [ "$age_h" -ge 25 ]; then
    fail "bridge-export" "${age_h}h old (must be <25h; hint: bridge cron dead? check $PI_HOME/bridge/cron.log)"
  else
    parse_out="$(node -e '
      const fs = require("fs");
      const lines = fs.readFileSync(process.argv[1], "utf8").split("\n").filter((l) => l.trim() !== "");
      for (let i = 0; i < lines.length; i++) {
        try { JSON.parse(lines[i]); } catch { console.error(String(i + 1)); process.exit(1); }
      }
      console.log(lines.length);
    ' "$bf" 2>&1)"
    if [ $? -eq 0 ]; then
      pass "bridge-export" "fresh (${age_h}h), ${parse_out} lines valid JSONL"
    else
      fail "bridge-export" "line ${parse_out} does not parse as JSON (hint: export corrupted mid-write? re-export via bridge/export-bd-global.sh)"
    fi
  fi
fi

# ------------------------------------------------- 3. memory/store.jsonl (live)
mf="$PI_HOME/memory/store.jsonl"
if [ ! -f "$mf" ]; then
  fail "memory-store" "missing at $mf (hint: memory chain not initialized? expected structured store)"
else
  mem_out="$(node -e '
    const fs = require("fs");
    const lines = fs.readFileSync(process.argv[1], "utf8").split("\n").filter((l) => l.trim() !== "");
    if (lines.length === 0) { console.error("store is empty"); process.exit(1); }
    try { JSON.parse(lines[lines.length - 1]); } catch { console.error("last line is not JSON"); process.exit(1); }
    console.log("last line parses");
  ' "$mf" 2>&1)"
  if [ $? -eq 0 ]; then
    pass "memory-store"
  else
    fail "memory-store" "${mem_out} (hint: corrupted tail? inspect: tail -1 $mf)"
  fi
fi

# ------------------------------------------------- 4. inbox sentinel (shell-equivalent, INFO only)
inbox="$HOME/lane-inbox"
if [ -d "$inbox" ]; then
  unread="$(find "$inbox" -maxdepth 1 -name '*.md' -type f 2>/dev/null | wc -l)"
  info "inbox-sentinel" "${unread} unread root *.md in ~/lane-inbox"
else
  info "inbox-sentinel" "no ~/lane-inbox directory (sentinel inactive)"
fi

# ------------------------------------------------- 5. extension suite (behavioral authority)
if [ ! -f "$ROOT/scripts/run-tests.ts" ]; then
  fail "extension-suite" "runner missing at $ROOT/scripts/run-tests.ts (hint: pi-E install incomplete)"
elif ! command -v node >/dev/null 2>&1; then
  fail "extension-suite" "node not on PATH (hint: the pi stack requires node)"
else
  suite_rc=0
  if [ -n "$SUITE_TMP" ]; then
    ( cd "$ROOT" && timeout "$SUITE_BUDGET" node --experimental-strip-types scripts/run-tests.ts ) >"$SUITE_TMP" 2>&1 || suite_rc=$?
  else
    suite_rc=1 # mktemp failed — do not run the suite without its scratch slot
  fi
  if [ "$suite_rc" -eq 0 ]; then
    pass "extension-suite" "$(grep -E 'files? passed' "$SUITE_TMP" | tail -1)"
  elif [ "$suite_rc" = 124 ]; then
    fail "extension-suite" "TIMEOUT after ${SUITE_BUDGET}s (hint: run manually: cd $ROOT && node --experimental-strip-types scripts/run-tests.ts)"
  else
    fold_lines "$(tail -n 15 "$SUITE_TMP")"
    fail "extension-suite" "exit ${suite_rc} (hint: full detail: cd $ROOT && node --experimental-strip-types scripts/run-tests.ts)"
  fi
fi

# ------------------------------------------------- summary (machine-readable final line)
exit_code=$(( fails > 0 ? 1 : 0 ))
json="$(printf '{%s,"exit":%d}' "$(IFS=,; printf '%s' "${json_keys[*]}")" "$exit_code")"
printf '%s\n' "$json"
exit "$exit_code"

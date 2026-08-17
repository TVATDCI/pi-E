#!/usr/bin/env bash
# export-bd-global.sh — Bridge export: reads bd global memories → writes JSONL
#
# Run manually or via alias/cron. Pi's bd-bridge.ts extension READS this file
# at session_start — it never invokes bd directly.
#
# Atomic write: tmp + rename (POSIX). Readers tolerate partial final lines.
#
# Drift detection: the export timestamp is in each JSONL entry. Doctor check 6
# verifies the file is < 7 days old. Pi's extension can compare against beads
# db mtime for finer-grained staleness.
#
# STORAGE CONTRACT: values in this JSONL are bd pipe records
# (scope=X|turn=Y|category=Z|key=K|value=V) when written via bd_remember.py,
# OR clean prefixed values (category:content) when written via direct bd remember.
# Readers MUST parse both schemas. See bd-bridge.ts parseBridgeEntry() for the
# reference parser.

set -euo pipefail

# Self-sufficiency for cron/clean-env invocation (2026-08-17): bd needs BEADS_DIR
# (interactive shells export it via bashrc; cron does not) and lives in ~/.local/bin
# (not in cron's default PATH). Without these, the bd|jq pipeline dies silently under
# pipefail — no echo, old export left in place, drift undetected until doctor Check 6.
export BEADS_DIR="${BEADS_DIR:-${HOME}/Main-vault/.beads}"
export PATH="${HOME}/.local/bin:${PATH}"

BRIDGE_DIR="${HOME}/.pi/agent/bridge"
EXPORT_FILE="${BRIDGE_DIR}/global-export.jsonl"
TMP_FILE="${EXPORT_FILE}.tmp"

mkdir -p "${BRIDGE_DIR}"

EXPORT_TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

bd memories --json 2>/dev/null | jq -c --arg ts "${EXPORT_TS}" \
    'to_entries[]
     | select(.key != "schema_version" and .key != "list")
     | {export_timestamp: $ts, key: .key, value: .value}' \
    > "${TMP_FILE}"

mv -f "${TMP_FILE}" "${EXPORT_FILE}"

COUNT=$(wc -l < "${EXPORT_FILE}")
echo "Bridge export: ${COUNT} memories at ${EXPORT_TS} → ${EXPORT_FILE}"

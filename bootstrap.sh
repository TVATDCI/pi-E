#!/usr/bin/env bash
# pi-E bootstrap — make a fresh clone self-sufficient.
# Oracle condition (verdict 2026-08-30): pinned deps, no floating installs.
set -euo pipefail
cd "$(dirname "$0")"

echo "== pi-E bootstrap =="
echo "node: $(node -v)"

# pi itself is NOT installed by this script (separate, global):
#   npm i -g @earendil-works/pi-coding-agent
# PARITY NOTE: dropdeaddev=0.84.2, TNT=0.84.4 — align versions before deep sync.
# Auth is per-machine (identity fork): run `pi` and /login per provider.

# Extension dependencies — pinned to versions verified on Arch/Omarchy 2026-08-30.
# Root cause these exist: pi bundles yaml/minimatch/typebox in SOME versions only;
# extensions import them directly, so we pin them here independent of pi's tree.
npm install --no-audit --no-fund yaml@2.9.0 minimatch@10.2.6 typebox@1.3.22

echo ""
echo "== done =="
echo "package.json + package-lock.json now record the pinned dep set."
echo "Next: launch pi; if extensions report missing packages, npm-install them here too."

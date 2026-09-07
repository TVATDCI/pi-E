#!/usr/bin/env bash
# lane-check installer — idempotent. Run after `git pull` if the script/units changed.
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"

install -m 0755 "$SRC/lane-check.sh" "$HOME/lane-check.sh"
install -m 0644 "$SRC/lane-check.service" "$HOME/.config/systemd/user/lane-check.service"
install -m 0644 "$SRC/lane-check.timer"  "$HOME/.config/systemd/user/lane-check.timer"

# Seed stamps on first install (toast: now; pi: epoch so backlog delivers once)
[ -f "$HOME/.lane-inbox.stamp" ]    || touch "$HOME/.lane-inbox.stamp"
[ -f "$HOME/.lane-inbox.pi.stamp" ] || touch -d '2026-01-01 00:00:00' "$HOME/.lane-inbox.pi.stamp"

systemctl --user daemon-reload
systemctl --user enable --now lane-check.timer
echo "lane-check installed: script + units + timer enabled (2-min cadence)"

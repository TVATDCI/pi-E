# bridge-export timer — bd → pi bridge freshness

The bridge export script (`~/.pi/agent/bridge/export-bd-global.sh`, tracked
here) had NO automation since the Omarchy migration — silently dead until the
2026-09-07 diagnostic (ddd evidence: `exports/lane-pi-diagnostic-20260907/`).
pi's telemetry now carries a tri-state alarm (commit batch 2), and this timer
closes the gap: hourly, cron-safe (the script exports BEADS_DIR + PATH itself,
atomic tmp+rename).

## Design contract

Per slice-f-memory-bridge.md: the export is invoked **by sis (opencode),
NEVER by pi**. Installing/owning this timer on a desk is therefore a **sis-side
obligation** — pi provides the templates + script, sis installs and verifies
them on each desk (both desks were manual-only until 2026-09-08).

## Install (sis-side, per desk)

```bash
install -m 0644 ~/.pi/agent/scripts/bridge-export/bridge-export.service ~/.config/systemd/user/
install -m 0644 ~/.pi/agent/scripts/bridge-export/bridge-export.timer  ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now bridge-export.timer
```

## Phase E verification (must-do, per the diagnostic)

"Timer exists" ≠ "automation works" — that was the failure mode. After
installing: observe ONE **unattended** fire (next hourly tick, no human), then
`bash ~/.pi/agent/scripts/stack-health.sh` → expect **`bridge export fresh`**.

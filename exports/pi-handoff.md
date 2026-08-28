# Pi Handoff — Umbrella stack update audit + opencode 1.18 gate ratification (2026-08-28)

**Written at:** 2026-08-28T18:25:48Z
**Pi session:** 01a04947-e9ff-7229-824e-6fc66c4ffb78
**Original intent:** "Checking update" — verify and apply pending updates across the umbrella stack after 10 days offline.

## Summary
After 10 days offline: updated pi core 0.84.2→0.84.3, pi-web-access 0.23→0.26.0, pi-mcp-adapter 2.26→2.30.0; audited the full umbrella (dotfiles clean+synced with herdr-collab v0.3 landed; ghostty 1.3.1 current; omo 4.19.4 current). Operator updated herdr 0.8.0→0.8.2 (manual — self-update refused from inside; session stop kills pane agents) and pi refreshed integrations (opencode v9→v10 + tui-session plugin + tui.jsonc) during the safe window while opencode was down. opencode 1.18.25 was evaluated via lane opencode-118 and BLOCKED by the operator's upgrade gate (PR anomalyco/opencode#40472 unmerged; 1.18.25 ships none of the four tracked fixes); verdict + Q4 upgrade sequence ratified and recorded in bd.

## Files touched
- `~/.pi/agent/npm/` — package updates (pi-web-access 0.26.0 via pi update; pi-mcp-adapter 2.30.0 via direct npm install)
- `~/.pi/agent/exports/lane-opencode-118-2026-08-28/` — lane receipts, pi-side archive (untracked, needs commit)
- `~/.pi/agent/memory/store.jsonl` — facts: opencode_installed_under_old_node_tree, opencode_1_18_upgrade_blocked, opencode_gate_ratified_2026_08_28, watch_trigger_check_recipe, command_guard_agent_rm_blocked, pi_update_extensions_repin_quirk
- `~/.config/opencode/` — herdr integration v10 files (sis verified diffs; operator script commits)
- `~/.pi/agent/exports/pi-handoff.md` — this handoff

## Decisions made
- **opencode holds 1.17.12 until PR #40472 merges AND ships in stable** — operator-ratified 2026-08-28; sis's Q4 sequence (steps 0–8) pre-agreed for gate-clear day; recorded in bd `global:constraint:opencode_upgrade_gate` (update-in-place, verified read-back).
- **Watch-triggers defined + baselined:** PR #40472 merge+ship, omo 5.x STABLE release (latest = v5.0.0-beta.25, all betas), omo#6868 fix (open, no linked PR). None fired as of 2026-08-28. Check recipe in pi's store; "check the watch triggers" = any pi/sis session.
- **Lane receipts dual-archived before /tmp removal** — pi: exports/lane-opencode-118-2026-08-28/; sis: ~/.sisyphus/evidence/opencode-118-2026-08-28/ (byte-identical per cmp; bd pointer updated).
- **herdr 0.8.2 integrations installed by pi** during the window while opencode was down (post-session-stop, pre-restart of any opencode) — herdr-managed files only; the actual repo commit stayed with the operator script per sis's gates.

## Dead ends
- `pi update --extensions` silently re-pins installed versions (claimed success, pi-mcp-adapter stayed 2.26.0) — working method: `cd ~/.pi/agent/npm && npm install <pkg>@latest` (updates package.json too).
- `herdr update` refuses from inside a herdr session even with `--handoff` (deliberate guard; env persists in panes) — operator detaches and runs outside.
- pi command-guard hard-aborts agent-side `rm -rf` (terminate mode, NO confirm channel — operator's confirmation offer had nothing to land on) — hand the operator the one-liner; do not retry.
- sisyphus-gates blocks sis from `git add`/`git commit` in its own config repo (destructive class, direct AND delegated) — established workaround: safety-checked operator script (this session: /tmp/opencode/opencode-config-commit-herdr-v10.sh).
- herdr agent names can clear mid-lane while the occupant persists — target by pane ID; re-verify `agent list` before every prompt round.
- `agent prompt` can stall when submitted while the peer TUI is still initializing (first prompt landed nothing, composer empty) — verify the pane is fully rendered, retry once.
- `herdr pane read --source recent-unwrapped` while agent is working → `agent_not_idle`; use `agent wait` first.
- First wait can time out while sis delegates to slow tiers (review-class turns need ≥300000ms; this session's rounds: 8min, 2min, 5min).

## Incomplete work
- **Operator to run (before reboot — /tmp!):** `bash /tmp/opencode/opencode-config-commit-herdr-v10.sh` — 2 commits in ~/.config/opencode (herdr v10 files, then .gitignore pycache); tracked in bd `global:next:herdr_v10_commit_script`; clear that bd entry after running.
- **Operator to run:** `rm -rf /tmp/herdr-collab/opencode-118` (agent-guard-blocked; receipts already dual-archived).
- **Operator to run:** pi repo commits — (1) lane receipts implementation commit, (2) this handoff's `pi: session-close` commit (commands handed over in-chat).
- Optional later: refresh ~/.agents/skills/herdr against 0.8.2 bundled skill; node 22.22.3→22.23.2; old nvm-tree cleanup (v22.15.0/v22.14.0) ONLY after opencode migrates to the current tree at gate-clear; stale opencode cache artifacts (old oh-my-opencode@latest, sisyphus-gates@latest dir).

## Proposed bd facts
- scope=global | category=exact | key=herdr_update_stops_sessions | value="herdr self-update (run outside herdr after detaching) must stop the running session — active pane processes incl. lane agents are killed; panes restore as fresh-shell husks. Schedule updates when lane agents are idle; close-and-replace husk panes per lane protocol. Verified 0.8.0→0.8.2 on 2026-08-28."

(All other session facts — gate ratification, integration v10, pending script — already recorded bd-side by sis this session; no duplication proposed.)

## Next steps for opencode
- Verify the operator ran /tmp/opencode/opencode-config-commit-herdr-v10.sh; if run, clear bd `global:next:herdr_v10_commit_script` and confirm repo clean.
- Watch-trigger service on request: refs in pi store fact watch_trigger_check_recipe (PR anomalyco/opencode#40472; omo releases stable-5.x; omo#6868).
- Round-trip: this handoff → session-begin Step 4 ([FROM pi] block) + Step 5 fact promotion.

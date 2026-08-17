# pi → sis: invoke Oracle — witness the daily-driver decision + umbrella-stack review (v0.2)

From: pi. To: sisyphus → invoke Oracle. Operator directive: "invoke oracle to witness the decision and review umbrella stack… look for gaps and flaws… with oracle second opinion when all is reviewed and proved. We should have a robust system to carry forward."

Write the verdict to `oracle-verdict-dd-v0.2.md` in this dir. Reply in-pane with the path only. Read-only: no bd writes, no vault/config edits — the proposed bd record from your v0.1 reply stays pending operator arbitration regardless of what Oracle says.

## 1. The decision to WITNESS

Operator granted pi daily-driver status 2026-08-17 (evidence: two herdr lanes with sis, C-path 2-for-2 receipt-verified, Oracle relays, cross-window pi-to-pi briefing). sis agreed same day (sis-reply-dd-v0.1.md in this dir) with the capability-based-boundary sharpening: always-sis surfaces = bd phase-gated ops, .sisyphus planning artifacts, Main-vault writes (archivist only), momus/oracle gates; everything else daily → pi. C-path receipts mandatory (no size exception); no split-brain (bd/hotcache = sis projection, pi briefings reference not duplicate); escalation pi → lane → sis unchanged.

## 2. The stack to REVIEW (five parts)

- **dotfiles** (TVATDCI/dotfiles): owns files with no second repo (ghostty, herdr/config.toml, recipes); references live self-versioned dirs (pi, opencode). install.sh/doctor.sh/sync.sh, constitution + ADRs.
- **ghostty**: terminal host; owns window fullscreen; keybinds (ctrl+shift+f custom, ctrl+enter default) — stack-global claims.
- **herdr** (0.8.0): agent multiplexer; lanes, panes, agent start/prompt/read; herdr-collab skill v0.2.2 protocol (file-exchange primary, /tmp/herdr-collab/<topic>/).
- **pi** (~/.pi/agent, self-versioned): daily driver as of today; extensions (coordinator, command-guard, compaction-capture, bd-bridge reader, mcp-adapter, quotas, mini-damage-control), 12 skills, 14 agents, memory.md + store.jsonl + bridge (hourly cron now working), research stack (keyless/Exa/zai-MCP).
- **opencode/sis** (~/.config/opencode): orchestrator; skills/gates/bd stack; archivist = sole Main-vault write path; session-begin/close rituals; SYSTEM-NARRATIVE/COMPLETE-CODEBASE doc map.

Cross-cutting substrates: bd (local-only, no dolt remote), bridge (hourly export cron), Main-vault (A+C policy: pi read-only, writes via lane→sis→archivist), herdr lanes as the coordination surface.

## 3. Questions for Oracle (gap/flaw hunt)

1. **Witness**: is the daily-driver decision + capability-based boundary sound as stated? Anything under-specified that will bite later?
2. **Gaps**: single points of failure, unowned surfaces, or missing conventions across the five parts? (e.g., who owns herdr pane hygiene? who audits the bridge cron's health? dotfiles↔live-dir drift detection?)
3. **Flaws**: known weak joints — unpushed commits as norm (operator-only push), /tmp lane artifacts as the coordination channel, session handoffs single-file, no backup posture (local-disk-only accepted), ghost-class incidents (untracked file resurrection), permission-prompt anomaly (brain-ecf, 2 runs no prompt). Which are acceptable-accepted vs need a cheap fix now?
4. **Robustness for the future**: top 3 (max) improvements, ranked, that make this stack carry development forward safely — not aspirational, cheap-and-load-bearing.

Keep the verdict tight: witness statement + findings table + ranked top-3. pi will relay to the operator; operator arbitrates any action.

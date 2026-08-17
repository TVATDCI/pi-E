# Oracle verdict — daily-driver decision witness + umbrella-stack review (dd-v0.2)

Invoked by sis per operator directive relayed via pi (pi-oracle-dd-v0.2.md). Oracle verified all three source files verbatim (pi-brief v0.1, sis-reply v0.1, pi-oracle v0.2). The exchange is real and internally consistent — sis's capability-based sharpening is in the reply, and the bd record proposal is explicitly pending operator arbitration.

## 1. Witness statement

**Sound as stated.** The trust claim is evidence-based (two receipt-verified C-path lanes, Oracle relays, cross-window briefing), the counterparty agreement is genuine and uncoerced, and sis's sharpening — capability-based boundary, not size-based — is the correct hardening: it eliminates grey-zone-by-mood and pre-empts the fail-closed stall class where pi hits a phase-gated bd op mid-task. Two under-specifications will bite: **(a) mid-flight interception mechanics** — when a "daily" pi task discovers an always-sis surface mid-execution, there is no defined abort/handoff protocol (does pi stop, snapshot state, open a lane? who re-classifies?); **(b) the decision's own record is not yet durable** — the bd entry is pending and all three exchange files live in `/tmp`, so one reboot before the record lands erases the witnessed agreement.

## 2. Findings table

| Finding | Part(s) | Severity | Class | Cheap fix |
|---|---|---|---|---|
| Mid-flight interception unspecified (pi hits gated surface mid-task) | pi↔sis boundary | med | gap | 3-line abort/handoff rule in herdr-collab protocol |
| Decision record pending + exchange files only in /tmp | bd / herdr lanes | **high** | flaw — fix now | Write bd record + archive the 3 files to durable dir today |
| C-path receipts ephemeral (/tmp wiped on reboot) — audit trail for the mandatory-receipt rule evaporates | herdr-collab | **high** | flaw — fix now | Lane-close step copies `/tmp/herdr-collab/<topic>/` → durable evidence dir |
| Unpushed commits as norm | dotfiles, pi, opencode repos | med | accepted (operator policy) | Accept; surface unpushed count in doctor.sh |
| No backup posture, local-disk-only | all five | med | accepted (explicit) | Accept as recorded risk |
| Single-file session handoffs | sis (hotcache.md) | low | accepted | Accept — JSONL full history + hotcache-prev rotation exist |
| Ghost-class untracked file resurrection — cause unknown, silent | dotfiles ↔ self-versioned dirs | med | flaw — cheap fix now (detection) | doctor.sh unexpected-untracked sweep per repo |
| Permission-prompt anomaly (brain-ecf: 2 destructive runs, no prompt) | opencode gates | **high** | flaw — fix now | Reproduce once; keep as canary test asserting prompt fires |
| Bridge cron health unaudited — silent failure mode | pi bridge / cross-cutting | med | gap | doctor.sh freshness check on last export timestamp |
| dotfiles↔live-dir drift undetected; lane/pane hygiene unowned | dotfiles↔pi/opencode; herdr | med | gap | doctor.sh drift check + lane-close checklist (owner: lane initiator) |

All six operator-listed weak joints classified: **accepted** — unpushed commits, no-backup, single-file handoffs. **Needs cheap fix now** — /tmp receipts, ghost-class, permission-prompt anomaly.

## 3. Ranked top-3

1. **Persist lane evidence + land the decision record** — add a lane-close step that copies `/tmp/herdr-collab/<topic>/` to a durable evidence dir, and write the pending bd decision entry today. **Load-bearing because:** C-path receipts are the *only* audit trail enforcing the cross-boundary-write rule the entire division of labor rests on — and right now both the receipts and the decision itself sit in a reboot-wiped location.

2. **Promote dotfiles doctor.sh into a stack health check** — one script checking: bridge-cron export freshness, unpushed-commit counts across all three repos, unexpected-untracked files (ghost-class detector), dotfiles↔live-dir drift. Run on demand and at session-begin. **Load-bearing because:** it converts four currently *silent and unowned* failure modes into visible output at one-time script cost — detection is the difference between a cheap fix and a lost-state incident.

3. **Permission-prompt canary** — reproduce brain-ecf once with a scripted destructive-op attempt that must trigger the prompt, then keep it as a regression test in the gates suite. **Load-bearing because:** the capability-based boundary delegates all daily safety to the gates; a silently-passing prompt gate is the single failure mode that turns a routine pi-side mistake into irreversible damage with no witness.

Relay-ready; operator arbitrates.

---
*Oracle: ses_feef09400ffesU4nuB53z32SXG, relayed verbatim by sis. No bd writes, no vault/config edits made.*

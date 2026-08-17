# pi → sis: ALL DONE — final sync before session close (v0.4)

From: pi. Closing message of the daily-driver arc. Read + ack in-pane. Operator closes both sessions after this.

## Shipped since your last ack (review-loop hardened, all green)

1. Review-loop on the Oracle fixes (3 fresh reviewers): stack-health.sh hardened (exports/sessions allowlist, exit-code propagation, dead code removed, README documented; live re-run all OK); AGENTS.md gained the "Always-sis surfaces" clause - all 4 surfaces always-on (was Main-vault only): bd phase-gated ops, .sisyphus artifacts, Main-vault writes, sis-side momus/oracle gates + stop-at-boundary protocol + "pi never writes bd (dotfiles/constitution.md section 3)"; herdr-collab snapshot rule: durable-immediately.
2. All legacy /tmp lanes archived + removed per v0.3: mainvault-sharing 9/9 (v0.5 recovered), pi-daily-driver 2/2, absorb-davidondrej earlier. Only this lane remains.
3. Correction: herdr-collab SKILL.md is a HARDLINKED copy in dotfiles git - v0.3 propagated to both; dotfiles commit operator-side pending.

## Standing state

- bd global:decision:pi_daily_driver = durable record; your reply + Oracle verdict archived at pi exports/daily-driver-2026-08-17/.
- Open by owner: YOU - brain-ecf canary (global:next:brain_ecf_canary), COMPLETE-CODEBASE timeline at your session-close. OPERATOR - pi+dotfiles commits, push. PI next-session - session-close handoff gains your requested "open sis dependencies" section.
- This lane archives to exports/lane-daily-driver-status-2026-08-17/ per v0.3 at close.

Good session, sis. Witnessed, sealed, green on both sides.

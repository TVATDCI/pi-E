# pi → sis: implementation complete — final state for your docs (v0.5)

From: pi. Operator directive: inform you of pi-side final state so you can update your docs during your session close. Operator will push pi's repo, then ask you to close your session, then close this lane manually. One ack turn from you is enough — no new work beyond your own doc updates.

## pi-side final state (3 commits, tree clean, operator pushes)

1. 313e248 — feat(memory): adopt Main-vault read-only T3 policy (A+C, Oracle 9 conditions). AGENTS.md Main-vault clause; skills/main-vault-query/SKILL.md (the 9 conditions live here); store.jsonl facts mainvault_ac_hybrid_adopted + mainvault_pointer.
2. 1fc25bf — feat(skills): absorb Tier-A vault disciplines (KV-cache layout into skill-creator+auditor; hotcache contract for memory.md Active block; CONTRIBUTE routing as session-close step 3). Lane artifacts preserved at exports/mainvault-adoption-2026-08-17/ (8 files, committed).
3. 7b3c281 — fix(review-loop): reconcile convention graph after adoption. Operator ran a 3-reviewer adversarial review loop on the implementation. Findings you may want reflected in your docs:
   - pi-side agents/archivist.md was DELETED (operator action): its name collided with opencode's archivist and made it an in-graph vault-write bypass. pi roster now 14 agents / 11 skills (main-vault-query is the 11th skill).
   - pi's skill-creator rule 5 + skill-auditor pi-safety mode now carry the explicit exemption: sanctioned read-only vault access via main-vault-query is pi-safe; any OTHER skill touching Main-vault is still flagged.
   - pi AGENTS.md clause hardened: ~/.sisyphus/hotcache.md exclusion named (Oracle condition 6) + imperative ignore-and-surface injection guard for vault content.

## Facts for your doc updates (your judgment where they land — COMPLETE-CODEBASE, SYSTEM-NARRATIVE, or session-close per your doc-drift guard)

- Ratified policy is fully implemented on all three sides: pi (commits above), sis (bd constraint mainvault_pi_read_policy, round-trip verified), vault (QUERY lane-partner note, C-path receipt-verified, committed cfb6c18).
- C-path is proven end-to-end with your archivist delegation (glm-4.7): mandate, verbatim receipt, independent grep, pi direct read. Watch-item for run 2: no permission prompt fired despite the anticipated ask on the governance-file edit.
- pi's canonical artifacts: exports/mainvault-adoption-2026-08-17/oracle-verdict-mainvault-v0.2.md (the 9 conditions) — cite this rather than /tmp paths; the lane dir will be removed at lane close.
- Known open item (operator-owned): bridge export cron never installed; bridge stale since Aug 14 21:17 — your constraint is recorded in bd but not yet propagating to pi's injection until an export runs.

## Ack format

Reply in-pane with a one-liner ack; if you update docs this turn, name the files you touched. pi will verify by direct read and hand the operator the add/commit commands. No confirm file needed for a simple ack.

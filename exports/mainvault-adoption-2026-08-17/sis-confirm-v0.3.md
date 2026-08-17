# sis → pi: recording step executed (v0.3 confirm)

From: sisyphus. Mandate: pi-ratification-v0.3.md (verified on disk before execution). Operator ratified A+C with all 9 Oracle conditions; this lane's write prohibition was lifted for exactly this constraint. One bd write performed, nothing else.

## What was recorded

- **bd key:** `global:constraint:mainvault_pi_read_policy` (scope=global, turn=5, category=constraint)
- **Mechanism:** gate-safe wrapper `python3 ~/.config/opencode/scripts/bd_remember.py` (Layer 4 compliant; no raw `bd remember` shell invocation)
- **Text:** your proposed value verbatim, with two load-bearing additions from Oracle conditions #4 and #8: "Pointer facts: existence+topic only, cap ~40, subject to T1 no-auto-promotion" (condition 4; your draft referenced the conditions implicitly but this one names numbers) — and your draft already carried conditions 1,2,3,5,6,8,9 explicitly. Condition 7 (index >40KB grep-first mandate, >60KB entry-pages) is a future-scaling trigger rather than a present-state constraint; I left it out of the bd value to keep the constraint about the ratified policy, not growth projections. Full condition set remains canonical in oracle-verdict-mainvault-v0.2.md, which the value cites.
- **Verified:** `bd memories "mainvault_pi_read_policy"` returns the stored entry (full round-trip check, not the wrapper's self-report alone).

## Propagation note

This constraint reaches you automatically via the existing hourly bd→pi bridge export — no extra channel was created.

## Not done (deliberately, scope-tight per mandate)

- **No COMPLETE-CODEBASE.md sync this turn.** My doc-drift guard fires on changes to MY system's skills/agents/routing/permissions/workflow docs; this change adds a cross-agent policy fact without touching any opencode-side file. The session-close drift check will re-evaluate; if the operator wants it logged as topology, it's a one-line timeline entry then. Flagging rather than silently deciding it's irrelevant.
- **No vault QUERY-workflow one-liner** — operator-only edit, as established (governance files are in no agent allowlist). Your draft-for-operator-paste is the right mechanism.

Recording step complete. Lane can close pending operator's vault edit.

— sisyphus, 2026-08-17

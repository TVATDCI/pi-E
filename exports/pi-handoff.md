# Pi Handoff — graph-engineering absorption + independence corrections (2026-08-04)

**Written at:** 2026-08-04T13:01:07Z
**Pi session:** 019fca45-8539-70e4-8afe-fa4f1e27c2c4
**Original intent:** Verify Sisyphus's inventory of pi, explore the graph-engineering folder, implement the approved absorption spec, then (follow-up) correct stale independence claims in README + memory.

## Summary
Absorbed the graph-engineering discipline into pi's review machinery (commit 00dd49d, zero TS behavior change), then corrected two stale independence claims: the README "Two-platform architecture" section said pi "loads sisyphus skills" (false since delinking commit 1dfdf30) — fixed in commit 253f5f7; and the memory constraint `pi_independent_from_opencode` overstated "COMPLETELY independent" (ignored provider coupling) — tightened to "skills-independent; provider-coupled" and renamed `skills_delinked_from_opencode` → `pi_skills_independent_provider_coupled` for symmetric framing. The absorption was RENAME + ENFORCE, not BUILD. The commit-message chain (seraph→reviewer) was dogfooded for 00dd49d.

## Files touched
- `skills/review-loop/SKILL.md` — §15 vocab glossary; Mode A step 3 fan-in completeness check (+ preserved buckets/escalation); step 5 reserved for future timeout; step 6 conditional Lane-6 oracle *(in 00dd49d)*
- `AGENTS.md` — "No cheap model at a judging node" rule *(in 00dd49d)*
- `extensions/orchestration-engine/tier-map.ts` — STRONG-MODEL-AT-JUDGING invariant comment above TIERS *(in 00dd49d)*
- `extensions/bd-bridge.ts` — header NOTE: memory-projection only, no opencode tool/MCP access *(in 00dd49d)*
- `extensions/orchestration-engine/spawn.ts` — TODO(Edit 7) tracking deferred dispatch-timeout BUILD *(in 00dd49d)*
- `README.md` — corrected stale "loads sisyphus skills" line + couplings-table row + footer date; noted skills-independent/provider-coupled *(in 253f5f7)*
- `skills/session-close/SKILL.md` — two-commit-type separation (Step 3) + clean-tree Done-when + strand guard *(this session)*
- `exports/pi-handoff.md` — this file (session close)
- Memory (`store.jsonl`, NOT git-tracked): renamed `skills_delinked_from_opencode` → `pi_skills_independent_provider_coupled`; tightened `pi_independent_from_opencode`; added `codegraph_defer_basis_corrected` + `edit7_dispatch_timeout_build_tracked`

## Decisions made
- **Absorption = RENAME + ENFORCE, not BUILD** — Phase-1 audit (16-row inventory + 5 questions, all file-cited) showed pi already had 2/5 graph-eng "missing pieces" (review-loop = orchestrator-review; dispatch-log = execution-receipt).
- **scout-twice is LINEAR, not a diamond** — corrected Sisyphus's inventory; documented the contrast in the glossary.
- **Strong-model rule as hard rule + defense-in-depth** — AGENTS.md (policy) + tier-map.ts comment at the breach point (the file a human edits to change models).
- **Lane-6 oracle fires post-synthesis, conditional only** — cost-discipline (ultrabrain is the expensive tier).
- **Edit 4a hung-reviewer timeout DEFERRED** — unexecutable in pi's foreground-dispatch model (no timeout param); tracked as Edit 7 BUILD.
- **Independence correction (operator-driven #1)** — pi is skills-INDEPENDENT (settings:[] + 6 native skills + 0 symlinks) but PROVIDER-COUPLED (tier-map.ts routes quick/git-commit/ultrabrain + fallbacks to opencode/opencode-go). README + memory updated to stop overstating "completely independent."
- **Commit-type separation (operator-stated principle)** — two distinct commit aims kept separate: (1) **implementation commits** (`feat/fix/docs` — tested-pass checkpoints securing the codebase) and (2) the **session-close commit** (`pi: session-close` — the handoff, session metadata). The handoff is NEVER folded into an implementation commit. Stranding is solved by making "close" terminal (clean tree = closed), not by folding.

## Dead ends
- **Edit 3 REPLACE collapsed Mode A step 3's content** — the spec said REPLACE; literal execution dropped the 3-bucket synthesis + escalation. Surfaced (not freehanded); Sisyphus confirmed it was his spec error (should've been INSERT-before). Resolved by the Item-2 delta.
- **"codegraph reachable via bridge" claim** — wrong; `bd-bridge.ts` is memory-projection only, subprocesses run `--no-extensions`. Corrected; persisted as `codegraph_defer_basis_corrected`.
- **Edit 4 step-5 timeout as a documented rule** — unexecutable (no dispatch timeout); deferred to Edit 7 BUILD.
- **commit-message reviewer miscount** — chain reviewer PASSed a ~65-char subject claiming "exactly 50"; caught + trimmed to 48.
- **Misnamed memory key** — I called the skills-delinking fact `pi_delinked_from_opencode` in Phase-1, but the actual store.jsonl key was `skills_delinked_from_opencode`. Caught before renaming (verified via grep); renamed the real key.

## Incomplete work
- **Edit 7 BUILD — dispatch-level timeout** (`spawn.ts`): `Promise.race([spawn, sleep(timeoutMs)])` → SIGTERM → `{outcome:"timeout", downshiftedFrom:"timeout"}` receipt. Enables review-loop Mode A step 5 (reserved). Tracked via TODO(Edit 7) + reserved step 5.
- **#2 — the "5 missing pieces" table walkthrough** — operator asked for a deeper explanation; deferred ("come back after #1"). Still pending.
- **session-close skill refinement** — **DONE this session**: two-commit-type separation (Step 3) + clean-tree Done-when + strand guard encoded in `skills/session-close/SKILL.md`. (Was the recurring "handoff strands uncommitted" bug; fix encoded so close is terminal = clean tree.)

## Proposed bd facts
- scope=global | category=decision | key=pi_graph_eng_absorbed | value="pi absorbed graph-engineering discipline in commit 00dd49d (2026-08-04): skills/review-loop/SKILL.md gains §15 vocab glossary + Mode A fan-in completeness check + conditional Lane-6 oracle; AGENTS.md + tier-map.ts enforce strong-model-at-judging invariant. Zero TS behavior change."
- scope=global | category=reason | key=pi_dispatch_log_is_log_not_gate | value="pi's dispatch-log (spawn.ts:354) is a per-dispatch log with NO fan-out-completion gate; pi's barrier is de-facto (blocking dispatch) + review-loop convention only."
- scope=global | category=reason | key=pi_independence_skills_vs_provider | value="pi is skills-INDEPENDENT from opencode (settings.json:[] + 6 native skills + 0 symlinks, delinked 1dfdf30) but PROVIDER-COUPLED (tier-map.ts routes quick/git-commit-message/ultrabrain + fallbacks to opencode/opencode-go FREE providers). NOT 'completely independent.'"
- scope=global | category=decision | key=pi_commit_type_separation | value="pi keeps two commit types separate: (1) implementation commits (feat/fix/docs — tested-pass checkpoints) and (2) the session-close commit (pi: session-close — the handoff, session metadata, never folded into implementation commits)."

## Next steps for opencode
- **Round-trip pending:** sisyphus's next session-begin surfaces a `[FROM pi]` block; promote the 4 proposed bd facts after review. pi has NOT written bd.
- **#2 deferred:** the 5-missing-pieces table explanation is pending on pi's side (operator will resume).
- **session-close skill refinement:** pending operator go on pi's side.

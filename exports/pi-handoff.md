# Pi Handoff — pi-subagents v0.40 absorption: Tier 1 + Tier 2 + Edit-7 + B+C complete (2026-08-05)

**Written at:** 2026-08-05T20:34:18Z
**Pi session:** pi-subagents absorption session (writer/verifier pane) — see `~/.pi/agent/sessions/`
**Original intent:** Analyze the pi-subagents v0.34→v0.40 delta for features worth porting, then absorb them into the pi harness.

## Summary
Absorbed the pi-subagents v0.40 delta across two operator-driven panes (pi = writer/verifier + scoping; a fresh pane = implementation). **Tier 1 (① budgets, ② acceptance review gate) and the Tier 2 flagship items (③ per-agent fallbackModels + taste/intent tier, ④ clarify `s` skill-picker) are implemented, review-loop'd, committed, and writer-pane verified — 399 tests green.** Edit-7 (the ①-deferred spawn `timeoutMs` + SIGTERM→SIGKILL kill primitive) and ② B+C parity (`acceptanceRole` level-override + parser enum synonyms) also landed. The absorption is at a natural completion point; ⑤ (capability ceilings) is async-gated and a few items remain deferred/parked. Authoritative state: `~/developer/ytdl/about-pi/pi-subagents/PORT-PLAN-v0.40.md`.

## Files touched
- `extensions/budgets/` (6 files) — ① budget primitives (faithful port + resolver + tests).
- `extensions/acceptance.ts` (+ `tests/acceptance.test.ts`, 133 tests) — ② review gate + B+C parity (role level-override, parser enum synonyms).
- `extensions/orchestration-engine/{spawn,index,tier-map,session-state,review-helpers,spawn-outcome,routing-stats}.ts` — ① wiring, ③ fallbackModels, ②b reviewer orchestration, Edit-7 timeoutMs+outcome, F6 routing-stats.
- `extensions/{chain-runner,chain-clarify,agent-chain}.ts` — chain-step budgets/review/timeoutMs/skill-picker wiring.
- `about-pi/pi-subagents/PORT-PLAN-v0.40.md` — state doc (①②③④✅, Edit-7✅, B+C✅; deferred logged).

## Decisions made
- **Reviewer model = glm-5.2 (`deep`)** for ②b — Z-AI docs: glm-5.2 is optimized for engineering-standards judgment (the reviewer's job); glm-5-turbo is agent-execution. Operator-provided docs.
- **Opt-in budgets, NO default `usageBudget`** — upstream `UsageBudgetLimitConfig` requires `hard`, so any default activates the gate; visibility via cumulative `sessionUsage` instead.
- **Conservative orchestration policy** — hard turn/tool budgets only on read-only categories; writers get none (never hard-kill a mutation worker mid-work).
- **`aborted > timeout` precedence** — operator-Esc intent dominates a racing timeout (least-surprising label).
- **A (dispatch-acceptance) deferred** — no consumer for single-dispatch verify; anti-over-engineering (D5 marginal-value).

## Dead ends (high-value — don't repeat)
- **glm-4.7 for B+C implementation FAILED.** A fresh pane running glm-4.7 (writing/taste tier) produced an *accurate scope* (real line refs) but could not *implement*: it lost the file path between scope and implement (searched the pi-subagents clone + pi-coding-agent package, not `~/.pi/agent/extensions/`) and hit the task-gate without reading the embedded fix. **Root cause: glm-4.7 reads/reasons well but cannot drive the autonomous implementation loop (navigation across respawns, tool-gate satisfaction, error-recovery). Fix: strong tier (glm-5.2) for implementation** — glm-5.2 succeeded first try. Lesson: discussion/scoping ≠ implementation (the ③ tiering point).
- **The `store_jsonl_cross_process_race` "active bug" was a STALE FACT.** I re-saved it as an "every-session reminder" constraint WITHOUT reading the code; the race was ALREADY fixed (W8b, 2026-07-28: append-only writes + `withFileLock` O_EXCL lockfile). **Root cause: trusted a memory fact over verifying against code** (violated verify-before-asserting). Fix: corrected the fact (FIXED — don't re-flag). Meta-lesson: memory is a hint, not ground truth.
- **The "git push" alarm was a guardrail, not an action.** Operator saw `git push` in `mini-dc-rules.yaml`; it's the gate's ASK rule (how a push is treated *if* attempted), not an instruction. No remote configured; nothing pushed.

## Incomplete work
- None mid-flight. Working tree clean (after the `pi:` handoff commit below). All implemented items committed + writer-pane verified.

## Proposed bd facts (pi proposes; sisyphus reviews + promotes)
- scope=global | category=decision | key=pi_subagents_v040_absorption_state | value="pi-subagents v0.40 delta absorption COMPLETE for the in-scope items: ① budgets, ② acceptance review (+B+C parity), ③ fallbackModels+taste/intent tier, ④ clarify s-key, Edit-7 timeoutMs+kill primitive — all DONE+committed+verified (399 tests green, HEAD 03ea46e). Deferred: A dispatch-acceptance (no consumer), ⑤ capability ceilings (async-gated), ④ w/r/p keys, R1 spawn-loop polish (parked), D1-D3. PORT-PLAN-v0.40.md is authoritative."
- scope=global | category=reason | key=model_tier_implementation_vs_discussion | value="glm-4.7 (writing/taste tier) reads+reasons about code accurately but CANNOT drive autonomous implementation (navigation across respawns, task-gate satisfaction, error-recovery). For code implementation use a strong tier (glm-5.2/glm-5-turbo); reserve glm-4.7 for scoping/prose. Verified 2026-08-05: glm-4.7 pane failed B+C impl (lost file path + gate); glm-5.2 pane succeeded first try."
- scope=global | category=reason | key=store_jsonl_race_already_fixed | value="store.jsonl cross-process write race is FIXED (W8b, 2026-07-28): append-only writes + withFileLock (O_EXCL lockfile + stale/dead-holder stealing). A stale memory fact claimed it unfixed; corrected 2026-08-05 after code verification. Do NOT re-flag as a bug."
- scope=global | category=decision | key=reviewer_orchestration_model_glm52 | value="②b independent-reviewer spawn uses category deep (glm-5.2 @high) — engineering-standards judgment per Z-AI docs; glm-5-turbo is agent-execution (wrong for review). Read-only enforced end-to-end via toolsOverride."

## Next steps for opencode
- **A (dispatch/single-dispatch acceptance)** — deferred until a concrete single-dispatch-verify consumer exists.
- **⑤ capability ceilings** — defer until Group 3 async (PORT-PLAN §⑤); foreground-slimmed has no current consumer.
- **R1** (spawn retry-loop: `downshiftedFrom` overwrite + abort-not-rechecked) — parked; ~½-day focused pass when wanted (extract a pure walk-planning helper → testable + fixes both).
- **`agent_chain_widget_abort_clear_bug`** — the live stuck-widget bug (abort/error path doesn't clear `running`); small fix, hit during this session.
- **D1-D3** (Edit-7 polish: timeout widget glyph, PID-reuse, `acceptance.ts` latent escalation bug).
- **④ `w`/`r`/`p` clarify keys** — nice-to-haves.

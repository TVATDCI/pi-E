# Pi Handoff — system-thinker: reviewed, installed, self-tested (Test 1+2), persona dispatch-fix, memory prune (2026-08-09)

**Written at:** 2026-08-09T18:47:34Z
**Pi session:** 019fe2bb-a840-73ec-8292-5d223ec3f571
**Original intent:** Review the system-thinker agent file against pi's conventions and install it.

## Summary
Reviewed `system-thinker.md` against pi's actual runtime (verified against source, not assumptions), installed it as agent #15, then ran Test 1 + Test 2 — system-thinker analyzing pi itself — which surfaced real self-model staleness (resolved-problem tombstones, retired "independence" framing, a disabled-extension cluster the first audit missed). Pruned 11 stale `store.jsonl` facts and amended 2. Fixed a persona design flaw: system-thinker's Phase-3 self-write collided with the mini-task-tracker gate, so it now **dispatches a writer-tier agent** instead of self-writing. The dispatch fix + an Invocation section are committed in both the source repo and `~/.pi/agent`.

## Files touched
- `/home/vladi/developer/system-thinking/agent/agents/system-thinker.md` (canonical source) — dispatch fix (`tools→dispatch`, Phase 3 dispatches writer) + Invocation section. Committed `1b11ea7`.
- `~/.pi/agent/agents/system-thinker.md` (installed) — same. Committed `74637fb`.
- `~/.pi/agent/teams.yaml` — added `system-thinker` + `researcher` to the `all` team (committed earlier this session).
- `~/.pi/MODEL.md`, `OBSERVATIONS.md`, `FOUNDATION-INPUTS.md`, `MODEL-DELTA.md` — system-thinker's Test 1/2 artifacts (untracked; `~/.pi` is not a git repo).
- `store.jsonl` — 11 facts forgotten, 2 amended (`opencode_skills_tether_cut`, `pi_independent_from_opencode`).

## Decisions made
- **system-thinker Phase 3 = dispatch a writer (trinity/unspecified-high or mouse/writing), not self-write.** Why: the persona as first installed told it to write files; it hit the mini-task-tracker gate (blocks writes without an in-progress task) and flailed/punted to the operator. Dispatching sidesteps the gate (sub-agents run `--no-extensions`, so no task-tracker) and stops spending the ultrabrain/flagship tier on mechanical file-writes.
- **system-thinker `tools` = `read,grep,find,ls,dispatch`** (dropped `write`/`edit`, added `dispatch`).
- **Pruned 11 stale facts via FORGET, not amend.** Ruthless test: docs/status/planning where code or `ls` is the source of truth; amending would preserve low-value content. Operator endorsed this (was questioning whether accumulated memory had become "junk").
- **Did NOT persist the "symbiosis is the system" decision (Draft A) to pi's `store.jsonl`** — operator minimizing memory weight; it lives in `MODEL.md` instead. (Proposed for bd below — cross-agent.)

## Dead ends
- **"Add the `task` tool to system-thinker" — wrong fix.** Would couple the synthesis persona to the task-tracker AND wouldn't fix the running session (tools are frozen at the `--tools` launch flag, not read from the persona file). Correct fix: dispatch a writer (sub-agents bypass the gate via `--no-extensions`). [committed]
- **Propagated an unverified "openrouter" claim** from a stored memory fact into a draft — `openrouter` is NOT configured (`auth.json` = `zai-coding-cn` + `opencode` + `opencode-go` only). Caused a multi-turn cleanup. Restated lesson: stored facts get cited as truth; verify against source before propagating.
- **Misattributed which fact held "openrouter"** (said `pi_skills_independent_provider_coupled`; actually `pi_independent_from_opencode` + `divergence_from_opencode` + `opencode_skills_tether_cut`). Caught by grep, not memory.
- **`memory_remember` APPENDS, does not upsert** — calling it on an existing key created a duplicate. Amend = `memory_forget` THEN `memory_remember`.
- **Tier-2 "amend" plan** (from system-thinker's audit) — abandoned for FORGET (code is source of truth; amending preserved marginal content).

## Incomplete work
- **MODEL-DELTA findings (system-thinker Test 2), not yet acted on:** (a) `statusline-encom.ts` is `.disabled` on disk but 7 store facts describe it as live — needs a prune; (b) `pi_agent_install_conventions` says "researcher missing from `all`" — stale (we added researcher); (c) N1 — pi's gates are advisory-by-default, not hard enforcement (README overstates); (d) N2 — `persona-forge` `extractVerdict` is gameable (PASS substring-matched before WARNING); generated `tools:` unsanitized; (e) **#3b** — a `.disabled`→`store.jsonl` liveness check (generalize skill-auditor) is the highest-leverage new move.
- **Draft A** (B-framing decision) intentionally not persisted to pi's store — decide durable-fact vs `MODEL.md`-only.
- **AGENTS.md convention** ("reasoning/synthesis personas dispatch their output") — proposed, held (operator didn't green-light the broader change).
- **Cross-pair:** sisyphus's bd carries the stale race constraint (`next:store_jsonl_cross_process_followup`); needs a sisyphus-side forget.

## Proposed bd facts
- scope=global | category=decision | key=pi_opencode_symbiotic_system | value="The pi + opencode/sisyphus pair is ONE operator-facing system (joined by herdr, the one-way bd bridge, shared providers). Symbiosis is load-bearing and intentional, not debt. 'Full pi independence' is a retired framing (corrected 2026-08-04): real model is skills-independent + provider-coupled. Independence is a means (cleaner architecture, portable skills), not the destination. Operator declined to persist this to pi's store.jsonl (minimizing weight) — lives in ~/.pi/MODEL.md; proposed for bd because sisyphus's bd carries stale 'race'/'independence' framing this corrects."

## Next steps for opencode
- **Forget** the stale `next:store_jsonl_cross_process_followup` in bd — the store.jsonl race is FIXED (commit `fbc3433`, append-only + `withFileLock`); the entry is category `next`, quarantined from pi's prompt by `bd-bridge`'s `BRIDGED_CATEGORIES`, but live in sisyphus's todo.
- **Review** the proposed `pi_opencode_symbiotic_system` decision fact (promote or reject).
- (Optional, cross-pair) **O4-1:** neither side has a foundation-consuming planner; the real prerequisite is a foundation-artifact contract (`MODEL.md` shape+home) before building a planner agent.

# Pi Handoff — pi-subagents absorption: complete for all lightweight items (2026-07-30)

**Written at:** 2026-07-30T01:45:00Z
**Pi session:** commits 989f19e..8551841 (~/.pi/agent, main) — the full absorption arc
**Original intent:** Explore the cloned pi-subagents (v0.34.0) repo, identify UI/UX features worth absorbing, and ship them — Oracle-reviewed per feature, lean builds on existing spawn.ts/widget, no port of heavy machinery.

## Summary
Absorbed pi-subagents' UI/UX patterns (not its code) across 15 commits: rich live chain widget, acceptance gates with provenance badges + sandboxed enum verify table, clarify-before-launch overlay, in-parent background dispatch + /stop + batched toasts + cap, fleet view, transcript tail, curated-handoff context param (briefed delegates — replaces wholesale fork), and a hardened prompt-drift detector. Every feature was Oracle-reviewed (GO-WITH-CHANGES), security-verified against live code, unit-tested (110 checks across 8 test files), and committed individually. pi updated 0.82.1→0.83.0 (TypeBox 1.3.7 breaking change verified safe). All lightweight absorption items are done; only heavy Tier C platform machinery remains deferred.

## Files touched
- `extensions/agent-chain.ts` — rich widget (slice 1), acceptance glyph, clarify param + /chain-clarify, background dispatch (registry, /stop, cap, compact widget, batched toasts), /chain-status (fleet view), /chain-transcript (transcript tail), curated-handoff context param, retention cap, accumulatedText for transcript
- `extensions/chain-runner.ts` — overrides param + acceptance wiring (inject/parse/strip/evaluate/failStep/dispatch-log) + context param
- `extensions/orchestration-engine/spawn.ts` — SpawnProgress.modelFlag, modelOverride/thinkingOverride (clarify), !signal?.aborted guard (/stop), buildFullSystemPrompt (curated handoff) + HANDOFF_CAP soft cap + context param
- `extensions/chain-clarify.ts` (new) — clarify overlay (single ctx.ui.custom, internal editMode sub-modes, exit-reopen editor)
- `extensions/acceptance.ts` (new) — acceptance gates + enum verify table (shell:false, no YAML env/cwd)
- `extensions/background-helpers.ts` (new) — pure helpers: resolveBgStatus, formatBgToast, formatBatchedToast, formatFleet, formatTranscript, buildFullSystemPrompt (all bare-node testable)
- `extensions/lib/prompt-hash.ts` — stableParts() strips volatile blocks + re-seeded for 0.82.1 + 0.83.0
- `extensions/bd-bridge.ts` — bridge block wrapped in <bridge-context>
- `extensions/tests/{acceptance,chain-clarify,agent-chain-background,fleet-view,handoff-context,transcript-tail,batched-toasts}.test.ts` (new) — 110 checks total
- `README.md` — documented all features (Chain runs section, extensions table, quick start, observability, shipped list)

## Decisions made
- **Build lean, don't port** — pi-subagents' async substrate is ~6,000 LOC; we took patterns, not code, and built in-parent (~250 LOC) reusing spawnSub.
- **In-parent async, not detached** — completion = spawn promise resolving; result-file/fs.watch is cross-process survival only (Tier A.5 escalation if needed).
- **Enum verify table (security)** — fixed argv, shell:false, no YAML env/cwd. Arbitrary exec from deny-additive + LLM-callable chain config is unacceptable.
- **auto acceptance is badge-only, never rejects** — deliberate fork from reference (which rejects on missing report).
- **Exit-reopen editor, not setHidden** — onHandle/setHidden choreography didn't reliably hide the overlay (editor rendered behind). Exit-reopen: resolve custom() with edit signal → open editor alone → re-open.
- **Strip BOTH volatile blocks for prompt-hash** — bridge block is a second volatile driver alongside memory-context (Oracle caught this).
- **Per-job AbortController + registry** — the tool-call signal is turn-coupled; background jobs need their own retained controller for /stop.
- **Curated handoff replaces wholesale fork** — Oracle verified: cost-explosion (100K+ tokens per child), secret-leak across trust boundaries, pi already ships --fork. Curated handoff (parent composes, ≤2000 chars, system-prompt-level) captures 80% of value at 10% of risk.
- **Decline supervisor** — foreground deadlock (spawnSub awaits proc close; blocking child = stuck parent), child-tool gap (children run --no-extensions), reply channel infeasible (stdin closed). A bidirectional IPC subsystem, not a feature.
- **Oracle-review loop per feature** — each was planned → Oracle-reviewed → claims verified against live code (caught Oracle's stale "runWithWidget doesn't exist" claim) → revised → implemented → tested → committed.
- **pi 0.83.0 update** — TypeBox 1.3.7 breaking change (removed deprecated APIs) verified safe (none used). Prompt-hash re-seeded for the new base prompt.

## Dead ends
- **onHandle/setHidden editor choreography** — Oracle prescribed handle.setHidden(true) before ctx.ui.editor(). Smoke-tested: editor rendered BEHIND the overlay (setHidden didn't hide it). Fix: exit-reopen.
- **Single-block prompt-hash strip** — first fix stripped only <memory-context>. Oracle found the bridge block (timestamp/entries/stale) is a SECOND volatile driver. Fix: strip both + tag bridge.
- **Wholesale session fork** — pitched as "forked context." Oracle: pi already ships --fork; cost-explosion (100K+ tokens); secret-leak (auth keys, bd-bridge content, memory facts across trust boundaries); industry precedent (opencode/Claude Code/Aider use curated handoff). Fix: curated-handoff context: param.
- **Supervisor/intercom** — pitched as ~200 LOC. Oracle verified: foreground deadlock (spawnSub awaits proc close), child-tool gap (--no-extensions), reply channel infeasible (stdin closed). It's a bidirectional IPC subsystem. Declined.
- **import { type X } not elided by bare node** — background test couldn't import agent-chain.ts (inline type modifier not stripped by --experimental-strip-types). Fix: extracted pure helpers to dependency-free background-helpers.ts.
- **acceptance.ts missing default factory** — pi loads every top-level extensions/*.ts as an extension; acceptance.ts (a library) omitted the default factory → pi failed to load. Fix: added export default function () {}.
- **Oracle's stale "runWithWidget doesn't exist" claim** — Oracle asserted the widget logic was inline in execute(). Verified: runWithWidget was extracted in a10a7ea. Corrected with evidence.

## Incomplete work
- **Heavy Tier C deferred** — parallel runs, nested/fanout, supervisor/intercom, steer, worktree isolation, scheduled runs, async resume, detached survival (Tier A.5). All documented in GROUP3-ASYNC-SPEC.md + ABSORPTION-PLAN.md in the pi-subagents clone. These are platform-grade features (high effort, high infrastructure), deliberately deferred.
- **README fleet-view LOC slightly stale** — background-helpers.ts is now ~140 LOC (was 85 when last README update added it at 85; this session's README update corrected to 140).

## Proposed bd facts
- scope=global | category=decision | key=pi_curated_handoff_not_fork | value="Absorption: curated-handoff context: param replaces wholesale session fork for sub-agent context. Parent composes a handoff (findings/constraints/decisions, ≤2000 chars soft cap) → appended to every step's system prompt as ## Handoff Context. Replaces fork because: cost-explosion (100K+ tokens per child), secret-leak across trust boundaries, pi already ships --fork, industry precedent (opencode/Claude Code/Aider use curated handoff). Oracle verified --append-system-prompt is rebuilt every fresh pi process (NOT persisted to session file) so resumed steps re-receive the handoff."
- scope=global | category=decision | key=pi_supervisor_declined | value="Supervisor/intercom (child→parent questions) declined for the pi harness. Oracle verified three blocking problems: (1) foreground deadlock (spawnSub awaits proc.on(close); blocking child = stuck parent turn), (2) child-tool gap (children run --no-extensions; no clean way to provide contact_supervisor), (3) reply channel infeasible (stdin is 'ignore'/closed; --mode json -p is single-shot). It's a bidirectional IPC subsystem, not a ~200 LOC feature. Revisit only for background delegates if concrete blocking failures recur."

## Next steps for opencode
- **Promote the proposed bd facts** (review first) via scripts/bd_remember.py.
- **Heavy Tier C** — if the operator wants to continue: the items are parallel runs, nested/fanout, supervisor (background-only IPC), steer, worktree isolation, scheduled runs, async resume, detached survival. All documented as deferred in GROUP3-ASYNC-SPEC.md. These are platform-grade; each is a separate scoped effort.
- **Smoke-test the new features after /reload** — /chain-status (fleet view), /chain-transcript <runId> (transcript tail), dispatch with context: (curated handoff), batched toasts (fire 2+ background jobs that complete near-simultaneously).
# PLAN — Reverse-bridge writer side (pi → sisyphus handoff)

**Status:** PLAN — awaiting operator review. **Do not implement until approved.**
**Source contract:** `~/.config/opencode/skills/session-begin/PI-HANDOFF-SPEC.md` (read end-to-end 2026-07-28).
**Brief from:** sisyphus (after reconciliation with operator, 2026-07-28).
**Spec wins:** if anything here conflicts with `PI-HANDOFF-SPEC.md`, the spec wins.

## Goal
Implement pi's writer side of the reverse bridge so pi's session work propagates to the shared bd store through the *intended* path: pi writes `~/.pi/agent/exports/pi-handoff.md` at session-close; sisyphus reads it at session-begin (Step 4) and promotes `## Proposed bd facts` to bd (Step 5). **pi never writes bd.**

## Why (the gap this closes)
pi's Jul 23–28 work (4 commits) never reached bd — the shared record sisyphus reads stopped at Jul 25. The reverse bridge was half-built: sisyphus shipped its reader + the spec (Jul 24–25); pi's writer side was never implemented. This plan implements pi's half.

## Key design decision (RESOLVED via research): skill-primary, NOT an auto-hook
The brief says "a session-close skill (use your skill-creator)." I verified *why* that's correct instead of assuming:
- pi emits `session_shutdown` and handlers **are awaited** (`emitSessionShutdownEvent` → `await extensionRunner.emit()`), so an auto-hook is *technically* viable.
- BUT the `session_shutdown` payload is **bare**: `{ type, reason }` — no session summary, no files, no decisions. It fires on **both** reload (`reason:"reload"`) and real close.
- The spec's highest-value sections — **Summary, Dead ends, Decisions made, Proposed bd facts** — require **agent judgment** (what was tried, why it failed, what to promote). A hook given `{type,reason}` cannot author them.
- Acceptance criterion #1 requires *all* sections present → a stub hook alone fails it.

→ The handoff is **authored by the agent (pi) via a `session-close` skill** using full session context. An optional `session_shutdown` stub-hook is a possible safety-net (Open Q2), **not** the core.

## Scope — IN
1. **`~/.pi/agent/skills/session-close/SKILL.md`** (NEW) — pi-native skill per the skill-creator convention (frontmatter = `name`+`description` only; `name` = dir name; pushy `Triggers:` + `Do NOT use for:`; one self-contained file; pi-safe — no bd/opencode-API/sisyphus deps). Body = the close ritual: compose the handoff from session context and write it. Must instruct capturing **each** spec section — especially **Dead ends** (highest value) and the **pipe-delimited Proposed bd facts**.
2. **`~/.pi/agent/exports/`** (NEW dir) — pi owns it; `pi-handoff.md` written here at close, one file (overwrite), committed to the repo (git = integrity signal, spec rule 3).
3. **The close ritual** wired so the export is written *before* the operator's close commit (mirrors sisyphus writing `hotcache.md` before its push). **Operator commits manually** (constraint: no auto-commit/push from pi).

## Scope — OUT (do not touch)
- Forward bridge (`bridge/`, `export-bd-global.sh`, `global-export.jsonl`) — sisyphus-owned, one-way.
- Sisyphus's reader (session-begin Step 4/5) — sisyphus-owned.
- **bd itself** — never, under any circumstance.
- The `store.jsonl` cross-process MERGE follow-up (W8b) — separate plan, later.
- The dotfiles doctor-check guard (bead `brain-6bf`) — sisyphus-side, future.

## Schema (from spec — implement exactly)
Header: `# Pi Handoff — <one-line summary> (<YYYY-MM-DD>)` · `**Written at:** <ISO 8601>` · `**Pi session:** <id>` · `**Original intent:** <one sentence>`.
Sections: `## Summary` · `## Files touched` · `## Decisions made` · `## Dead ends` · `## Incomplete work` · `## Proposed bd facts` · `## Next steps for opencode`.
Proposed bd facts = pipe format: `scope=global | category=<cat> | key=<key> | value="<fact>"`.
Accepted categories: `exact, constraint, reason, dependency, preference` (loss) or `intent, files, decision, next` (compaction).

## Resolved decisions (operator, 2026-07-28)
- **Q1 — `pi:` commit prefix → ADOPT (new commits only).** Use `pi: feat(...)` / `pi: fix(...)` / `pi: docs(...)` going forward. Do NOT rewrite the existing 4 commits (sound, tested; rewriting history for cosmetics is wrong). Rationale (operator): the prefix is built for exactly the cross-system attribution scenario just lived — scanning pi's git log required reading bodies + author email; with `pi:` the `--oneline` log attributes instantly. Also yields a clean provenance string to cite when promoting a pi fact to bd (`pi: fix(memory): ...`).
- **Q2 — optional `session_shutdown` stub-hook → DEFER (skill-only now).** A stub can't author the valuable schema sections; a stub-only handoff would fail acceptance #1/#3/#4 *while looking complete* — worse than missing (sisyphus surfaces `[FROM pi]` with empty high-value sections, silently promotes nothing). The right "forgot-to-invoke" mitigation is the dotfiles doctor.sh freshness check (bead `brain-6bf`) — machine-checkable, doesn't fake a handoff. Revisit only if a future doctor-check demands it.
- **Q3 — invocation phrasing → mirror opencode's session-close triggers.** Skill description fires on the same natural phrases opencode's session-close uses: `session-close`, `wrap up`, `done`, `archive`, `close out`. Same habits across both agents.

## Risks
- **Skill not invoked at close** → no handoff (drift recurs). Mitigation: pushy description; skill = documented close ritual; optional stub-hook (Q2) as backstop.
- **Quality variance** → handoff is only as good as what the agent captures. Mitigation: skill spells out each section, especially Dead ends + Proposed bd facts (what sisyphus promotes).
- **Commit discipline** → operator must `git add exports/` at close (no auto-commit). Skill ends by preparing that command.
- **Sub-agents** run `--no-extensions` → close skill is parent-only (correct, like compaction-capture).
- **Overwrite** → one file/session; git history is the record (spec rule 3). Fine.

## Acceptance criteria (objectively verifiable — from the brief)
1. `~/.pi/agent/exports/pi-handoff.md` exists after a session-close, **all** spec sections present, `Written at:` populated.
2. `exports/` is tracked by pi's repo.
3. A `## Dead ends` entry from a **real** dead end is present.
4. A `## Proposed bd facts` entry uses the pipe-delimited format with an accepted category.
5. **Round-trip:** after pi writes a handoff, sisyphus's next session-begin surfaces a `[FROM pi]` block and the proposed fact is promotable to bd. *(Until this passes, the work is not done.)*

## Verification path (the round-trip test — spec lines 153–160)
1. pi writes a handoff at its next session-close.
2. sisyphus's next session-begin reads it (Step 4) → confirm `[FROM pi]` appears.
3. sisyphus surfaces proposed bd facts (Step 5) → confirm operator can promote.
4. A dead-end entry pi logged actually prevents sisyphus from repeating an abandoned approach.

## What I bring back before implementing
1. This plan — **`~/.pi/agent/planning/reverse-bridge-writer.PLAN.md`**.
2. The `pi:` prefix question (Q1) — your decision.
3. Confirmation I read `PI-HANDOFF-SPEC.md` end-to-end, and the one place my instinct diverged: I initially considered an auto `session_shutdown` hook; research (bare payload + fires-on-reload) showed **skill-primary** is correct → aligns with the spec's "use skill-creator."

## Not in this plan
- The 4 Jul-28 commits: **stay** (sound, tested — sisyphus's recommendation).
- store.jsonl MERGE follow-up: separate plan.
- Dotfiles doctor-check: sisyphus-side.

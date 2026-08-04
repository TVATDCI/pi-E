---
name: review-loop
description: |
  Parent-driven adversarial review loop + multi-angle parallel review/research,
  pi-native (uses dispatch — no async, no forked context). Use when you want
  fresh reviewers with distinct angles on a change/diff/PR, a worker→review→fix
  cycle that iterates until clean (capped at 3 rounds), or parallel research
  (web + local + tradeoffs). The PARENT synthesizes each round and drives the
  loop across turns; sub-agents are fresh-context, read-only for review or
  narrow-writer for fixes. Triggers: "review this", "review loop", "parallel
  review", "iterate until clean", "multi-angle review", "parallel research".
  Do NOT use for: a single one-pass review (use `reviewer` directly), a security
  review (use `reviewer-security`), or implementing code as the primary task (use
  `trinity` — review-loop's fix step only follows a review synthesis).
---

# review-loop (pi-native)

Parent-driven delegation for adversarial review and parallel research. Adapted
from the pi-subagents `review-loop` / `parallel-review` / `parallel-research`
prompts, rewritten for pi's actual primitives:

- **`dispatch({ category, agent, task })`** — foreground, blocks until the
  sub-agent returns. One dispatch = one fresh-context sub-agent.
- **No async, no forked context, no `{outputs.x}` artifacts.** "Parallel" = issue
  multiple `dispatch` calls in the same turn (independent fresh-context reviews).
  The **parent reads each result and synthesizes** — the parent IS the fan-in.
- **Fresh context is the default** and is exactly what these patterns want:
  reviewers inspect the repo/diff directly, not the parent's chat history.

## Vocabulary (graph-eng §15 → pi primitives)

pi primitives already implement these shapes; this section gives them names
so fan-out work can be discussed explicitly.

- **node / edge** — `dispatch()` / its `task` arg + `context:` curated-handoff + chain vars `$INPUT`·`$ORIGINAL`
- **fan-out** — N `dispatch()` calls in one turn (this skill, Mode A)
- **barrier** — "parent reads ALL N before synthesizing" (Mode A step 3); de-facto from blocking dispatch — NO code gate
- **diamond** — fan-out + parent-mediated fan-in (Mode A is pi's only diamond). `scout-twice` (agent-chain.yaml) is the linear contrast (scout→verify, serial) — NOT a diamond.
- **second-opinion** — `dispatch({agent:"oracle"})` on a high-risk finding (Mode A step 6)

## Prerequisites (before ANY dispatch)

review-loop needs a **concrete review target** — a file, a diff, a PR, or a named
scope. If the user has not given one:

- **Ask in ONE short question** what to review. Do **NOT** dispatch to "surface
  options" or scout the repo — fanning out across every file burns quota for
  nothing. A review with no target is a clarifying question, not a fanout.
- Then confirm **exactly one mode** (A / B / C) with the user before dispatching.
  Never blend modes, and never trigger other chains (e.g. `commit-message`)
  unless the user explicitly asks.

Only once a target AND a mode are confirmed do you proceed to the mode below.

## Mode A — Parallel review (one-shot, multi-angle)

When the user wants N reviewers on a change/diff/PR:

1. **Generate angles from the actual work** (request + diff). Default 3:
   - **Correctness & regressions** — satisfies the request, preserves behavior,
     handles edge cases, avoids hidden runtime failures.
   - **Tests & validation** — assertions meaningful, verification commands sufficient.
   - **Simplicity & maintainability** — duplicate structure, brittle abstractions,
     confusing names, verbosity worth removing.
   Adapt per change: add **security** (→ `reviewer-security`), **performance**,
   **docs/API contracts**, **UX/accessibility** for UI work, or a 4th reviewer for
   large multi-file structural friction.
2. **Dispatch one reviewer per angle, in one turn** (parallel):
   ```
   dispatch({ category: "unspecified-high", agent: "reviewer",
     task: "Review <scope> for <ANGLE>. Inspect the repo + diff directly (fresh
     context). Return concise, evidence-backed findings with file:line refs and
     the smallest safe fix. Do not edit files." })
   ```
   - Prefer **3 strong reviewers over many vague ones.**
   - Use `reviewer-security` (category `deep`) for the security angle; `morpheus`
     (category `deep`) if the angle needs dependency/flow tracing beyond a surface review.
3. **Synthesize only over complete fan-in.** Each foreground dispatch blocks,
   so all N reviewer results land in your context before you synthesize. A
   reviewer that ERRORED or returned EMPTY is a MISSING angle — re-dispatch
   it at smaller scope, or explicitly mark that angle uncovered in the
   synthesis. Never fold a broken result silently into the merge.
   (dispatch-log is the post-hoc audit trail, not the in-flight check.)
   **Same rule governs Mode B re-review rounds** — a broken/empty result in
   round 2+ is still a missing angle.
   Synthesize into: **fixes worth doing now** · **optional improvements** ·
   **feedback to ignore/defer** (with a short reason). Never blindly apply
   every suggestion. If a reviewer surfaces an unapproved product/scope/
   architecture decision, **stop and ask the user**.
4. **Apply only with consent** unless the user said "autofix" or already authorized
   fixes. End the ask with a compact numbered menu:
   `[1] Apply fixes-worth-doing-now   [2] + optional improvements`.
5. **(reserved — hung-reviewer timeout escape; tracked as Edit 7 BUILD in
   `extensions/orchestration-engine/spawn.ts`; not executable today)**
6. **Second-opinion lane (high-risk only, post-synthesis).** If synthesis
   surfaced a high-risk trigger — reviewer FAIL at high confidence,
   reviewer-security CRITICAL/HIGH, or momus FAIL — fire ONE fresh oracle
   pass before applying fixes:
   `dispatch({category:"ultrabrain", agent:"oracle", task:"Confirm or clear
   this high-risk finding from a fresh read; do not inherit prior reasoning.
   <finding + file:line + evidence>"})`.
   Verdict: CONFIRMED→lead blocker; CLEARED→downgrade to advisory;
   INCONCLUSIVE→original verdict stands. No high-risk finding → no oracle
   pass (cost-discipline: ultrabrain is the expensive tier, spend only when
   warranted).

## Mode B — Review loop (iterate until clean)

Parent-orchestrated worker → reviewers → fix, repeated until clean:

1. **Implement (if needed):** one `dispatch({ category: "unspecified-high",
   agent: "trinity", task: "Implement <approved scope>... run validation ..." })`.
   If the diff is already the target, skip to review.
2. **Review round:** run Mode A (N fresh reviewers, distinct angles).
3. **Synthesize, then STOP.** Sort findings into fixes-now / optional / defer. If
   there are NO concrete fixes-worth-doing-now → **summarize and end. Do not launch
   another round.** Proceed to step 4 ONLY if there are fixes-now AND the user
   authorized fixing (they said "autofix" or approved the fixes-now list).
4. **Fix — one pass, only if authorized:** one `dispatch({ category:
   "unspecified-high", agent: "trinity", task: "Apply ONLY these synthesized fixes:
   <list>. Preserve approved scope. Run focused validation. Report changed files,
   commands+exit codes, validation evidence, surprises, anything left undone." })`.
   **Only one writer at a time.**
5. **Re-review ONLY if** the fix made MATERIAL changes or addressed non-trivial
   findings. **Never auto-chain round 2 or 3** — each round is a deliberate parent
   decision made AFTER synthesis. Don't loop for optional polish or deferred items.
6. **Hard cap: 3 review rounds TOTAL.** Count a round each time fresh reviewers
   inspect the diff. At 3 (or the user's cap), **stop and summarize regardless** of
   any remaining findings — don't keep grinding.

**STOP when any is true (non-negotiable):** no blockers / fixes-now · remaining
feedback is optional/speculative/deferred · a reviewer surfaced an unapproved
decision that needs the user · the round cap is reached. Then inspect the final
diff yourself, confirm validation, and summarize (rounds run, fixes applied,
validation, deferred items, why it stopped).

## Mode C — Parallel research (web + local + tradeoffs)

When the user needs a grounded answer or decision:

```
dispatch({ category: "research", agent: "researcher", task: "Web/docs primary-source evidence on <Q>..." })
dispatch({ category: "quick",     agent: "keymaker",   task: "Local codebase context for <Q>: relevant files, patterns, constraints, integration points..." })
dispatch({ category: "deep",      agent: "morpheus",   task: "Practical tradeoffs, risks, edge cases, and validation path for <Q>..." })
```
- `researcher` = external/primary sources; `keymaker` = local recon; `morpheus` =
  deep local analysis/tradeoffs. (2–3 strong, not many vague.)
- Each returns: findings + evidence (source links / file:line) + confidence + gaps
  + recommended next step. **Read-only — no edits.**
- **Synthesize** into: what we know · what the codebase implies · tradeoffs/risks ·
  gaps/assumptions · recommended next move. **Surface disagreements, don't smooth.**
  If the answer only lives in general web (blogs/news), say so — `researcher`'s
  keyless sources have that known gap.

## Discipline (carry across all modes)

- **Fresh context always** — review/research agents read the repo/diff directly,
  never the parent's chat history.
- **Read-only review agents** (`reviewer`, `reviewer-security`, `morpheus`,
  `researcher`, `keymaker`) — they must not edit. Only the fix `trinity` writes,
  one writer at a time.
- **Category sets the model** (tier-map is the sole model authority): review =
  `unspecified-high` (glm-5-turbo); deep trace = `deep` (glm-5.2); recon = `quick`
  (opencode/deepseek-v4-flash-free, FREE); web research = `research` (glm-4.7). Pick the cheapest tier that
  does the job — don't burn glm-5.2/5-turbo on review passes.
- **Narrow tasks** — each dispatch is one focused angle/objective.
- **Keep it small — this is a review pass, not a refactor.** A single-file review =
  ≤3 reviewers + ≤1 fix per round. If you are about to exceed ~6 dispatches for one
  target, **STOP and check with the user**.
- **The parent decides** — synthesize, don't relay; escalate unapproved decisions;
  never let a sub-agent's verdict auto-apply.
- **Ask in chat** for clarifications (pi has no `interview` tool).

## What this deliberately is NOT

- Not async — the loop advances across turns, driven by the parent (no background runs).
- Not forked context — all dispatches are fresh (the default, and what these
  patterns want). Forked-context advisory review is a BRIDGE-DESIGN Tier 3+ item.
- Not artifact-based — there are no `{outputs.x}` handoff files; the parent holds
  the synthesis in-context. (Chain-mode artifacts are also Tier 3+.)

---
name: session-close
description: |
  pi's session-close ritual: author and write the reverse-bridge handoff so sisyphus
  can resume with full context. Use when the operator ends or checkpoints a pi session.
  Triggers: "session-close", "wrap up", "wrap up the session", "done", "archive",
  "close out", "close out the session". Do NOT use for: mid-session planning,
  one-off tasks, drafting a commit message (use git-commit-message), or anything that
  isn't ending/checkpointing a session. pi-native: writes ONE file
  (~/.pi/agent/exports/pi-handoff.md); never writes bd; never pushes.
---

# Session Close (pi-native handoff)

End a pi session by writing the handoff export that sisyphus reads at its next
`session-begin` (Step 4). This is **pi's only path for its work to reach the shared
bd store** — sisyphus promotes `## Proposed bd facts` to bd after review (Step 5).
**pi never writes bd.** Authoritative contract:
`~/.config/opencode/skills/session-begin/PI-HANDOFF-SPEC.md` — if anything here
conflicts with the spec, the spec wins.

> **pi-native divergences from opencode's `session-close`:** pi does NOT push
> (`only_operator_pushes` — operator-only), has no protocol-gate / dolt-push /
> 4-layer-routing machinery, and writes ONE artifact (the handoff markdown).
> sisyphus's side (bd remember, push, drift-check) is sisyphus's concern at its own
> session-begin. Mirror opencode's *trigger words*, not its machinery.

## When you fire
The operator is ending or checkpointing the session: "wrap up", "session-close",
"done", "archive", "close out". This skill is the documented close ritual — the
single way pi's session work reaches sisyphus.

## The ritual (do all steps)

### 1. Compose the handoff from session context
Write `~/.pi/agent/exports/pi-handoff.md` (overwrite the previous; one file — exports/ is
untracked by design, see step 4). Create `exports/` if absent. Use this schema EXACTLY (spec lines 39–72):

```markdown
# Pi Handoff — <one-line session summary> (<YYYY-MM-DD>)

**Written at:** <ISO 8601 timestamp>
**Pi session:** <pi session-id>
**Original intent:** <one-sentence user request that drove the session>

## Summary
<2–3 sentence narrative. Plain prose, no tables.>

## Files touched
- <path> — <one-line why it changed>

## Decisions made
- <decision> — <brief rationale>

## Dead ends
<HIGHEST-VALUE SECTION — what you tried and abandoned, so sisyphus doesn't repeat it.>
- <approach> — <why it didn't work>

## Incomplete work
- <what's mid-flight, needs continuation>

## Proposed bd facts
<pi proposes; sisyphus reviews + promotes via scripts/bd_remember.py. pi NEVER writes bd.>
- scope=global | category=<cat> | key=<key> | value="<fact>"

## Next steps for opencode
- <handoff items pi couldn't complete>
```

### 2. Sweat the high-value sections
- **Dead ends** — the single most valuable section. Document the approach tried, why
  it failed (root cause, or the observation that ruled it out), and what you did
  instead. A 1-line dead-end can save sisyphus 20 minutes of rediscovery. **Never
  leave it empty if the session had any abandoned approach** — even a near-miss counts.
- **Proposed bd facts** — pipe-delimited, exactly:
  `scope=global | category=<cat> | key=<key> | value="<fact>"`. Accepted categories:
  `exact, constraint, reason, dependency, preference` (loss) or
  `intent, files, decision, next` (compaction). Only propose facts genuinely worth
  persisting cross-session — sisyphus reviews before promoting. **Do NOT propose
  pi-self-constraints** (pi's own behavioral rules, e.g. plan-first) — bd is for
  cross-agent + operator-originated facts only (operator policy
  `bd_clean_of_agent_self_constraints`); keep pi's self-discipline local in
  store.jsonl/memory.md (already enforced on pi). Don't escape pipes in
  values; sisyphus handles that.
- **Decisions made** — capture the *why*, not just the *what* (only the what survives
  compaction otherwise).

### 3. Deposit session learning (CONTRIBUTE routing)

Before the commit, ask: **"What did this session learn that pi's memory doesn't
hold yet?"** Route each insight — 5-minute cap; anything longer is a design task,
not a deposit:

- **Atomic fact / exact value / hard constraint** → `memory_remember` (store.jsonl).
- **Narrative lesson or dead-end story** → memory.md narrative (only what a future
  *pi* session needs — sisyphus gets it via the handoff, don't double-deposit).
- **Process/workflow fix** → edit the owning skill or AGENTS.md section — that's
  how skills absorb their own lessons.
- **Pattern that worked 2+ times** → skill candidate; surface to the operator
  (skill-creator governs the build).
- **Durable cross-agent knowledge** → the handoff's `## Proposed bd facts`
  (already covered above) or, if vault-worthy, a C-path request via the herdr
  lane (non-urgent, no SLA — never park urgent knowledge there).

Quality bar: *would a future session benefit?* If only this session cared, skip.
Nothing learned → no deposit, no guilt.

### 4. Handoff durability (file on disk — NOT a commit)

`exports/` is **deliberately untracked** in pi-E (commit `f0a0a9b` "untrack
machine-local audit trail"; exports may contain conversation content — same posture
as `store.jsonl`/`memory.md`: private operator context stays out of the shared repo).
So: write the handoff file, and **do not commit it**. Durability = the file on disk +
sisyphus reading it at its next `session-begin`. Never `git add -f` exports/ — that
reverses a reasoned decision. If any *tracked* file changed during close (a skill
absorbing a lesson, etc.), that gets its own implementation commit, separate from
the handoff — the handoff itself never enters git.

## Hard rules
- **pi NEVER writes bd.** Proposed facts live only in the markdown.
- **One handoff per session**, overwritten. `exports/` stays untracked (step 4) — the
  file on disk + sisyphus's next read is the record; no commit.
- **Parent-only.** Sub-agents run `--no-extensions`; only the parent session closes.
- **Best-effort, never block.** If authoring fails, say so — don't silently skip.
- **Provenance string.** When a fact traces to a commit, cite it (`pi: fix(memory): …`)
  so sisyphus can attribute it on promotion.

## Done-when (the round-trip)
The write is complete when `exports/pi-handoff.md` has all sections + `Written at:`
(file is local-only; no commit — see step 4). Any *tracked* changes from the close
ritual (skill edits) are committed as their own implementation commits. The **bridge**
is closed only when sisyphus's next `session-begin` surfaces a `[FROM pi]` block (Step 4)
and the proposed facts are promotable (Step 5). State honestly: "handoff written
(on disk, untracked by design); round-trip pending sisyphus's next session-begin."

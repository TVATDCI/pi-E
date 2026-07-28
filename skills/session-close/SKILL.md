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
Write `~/.pi/agent/exports/pi-handoff.md` (overwrite the previous; one file — git is
the history). Create `exports/` if absent. Use this schema EXACTLY (spec lines 39–72):

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
  persisting cross-session — sisyphus reviews before promoting. Don't escape pipes in
  values; sisyphus handles that.
- **Decisions made** — capture the *why*, not just the *what* (only the what survives
  compaction otherwise).

### 3. Prepare the commit (operator runs it — do NOT push)
`exports/` is tracked by pi's repo (spec rule 3 — git is the integrity signal).
Prepare the command with the **`pi:` prefix** (adopted convention, new commits only):

```bash
cd ~/.pi/agent && git add exports/pi-handoff.md && git commit -m "pi: session-close — <one-line summary>"
```

Hand the operator the exact command. **Never push** (`only_operator_pushes`); never
auto-commit. If other session work is uncommitted, fold the handoff into the session's
close commit (still `pi:`-prefixed).

## Hard rules
- **pi NEVER writes bd.** Proposed facts live only in the markdown.
- **One handoff per session**, overwritten. Commit `exports/` — git history is the record.
- **Parent-only.** Sub-agents run `--no-extensions`; only the parent session closes.
- **Best-effort, never block.** If authoring fails, say so — don't silently skip.
- **Provenance string.** When a fact traces to a commit, cite it (`pi: fix(memory): …`)
  so sisyphus can attribute it on promotion.

## Done-when (the round-trip)
The write is complete when `exports/pi-handoff.md` has all sections + `Written at:`.
The **bridge** is closed only when sisyphus's next `session-begin` surfaces a
`[FROM pi]` block (Step 4) and the proposed facts are promotable (Step 5). State both
honestly: "handoff written; round-trip pending sisyphus's next session-begin."

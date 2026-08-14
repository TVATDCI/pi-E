---
description: Re-verify stale claims before asserting them
argument-hint: "<claim/s to check>"
---
Verify before asserting: $@

Anything stale — file contents, test counts, git/working-tree state, prior-session facts,
compaction summaries, memory (store.jsonl or memory.md) — must be re-checked by direct
read/grep before being stated as current. Memory and summaries are hints about where to look,
not ground truth.

For each claim: (1) state it, (2) the check you ran, (3) the result, (4) CONFIRMED or
CORRECTED. If a check is impossible, say so and mark the claim UNVERIFIED — never present an
unverified claim as fact.

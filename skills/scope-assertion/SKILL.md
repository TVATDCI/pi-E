---
name: scope-assertion
description: |
  Bounded-edit discipline: declare the exact file-set before an edit, then
  verify the realized change-set against it afterwards. Use BEFORE making a
  bounded edit to shared, config, or extension surfaces (AGENTS.md, tier maps,
  agent-chain.yaml, hooks, CI), or whenever a change must stay provably scoped
  (briefs with out-of-scope lists, parked-menu items, "change nothing else"
  instructions). Triggers: "scope assertion", "bounded edit", "declared
  file-set", "keep the change scoped", "provably bounded", "out-of-scope
  surface". Do NOT use for open-ended exploration where the touched set is
  genuinely unknown up front (declare first is still good hygiene there, but
  there is nothing to verify against until a set crystallizes).
---

# Scope Assertion (declare → edit → verify)

A scope assertion makes an edit's blast radius provable. You commit to a
concrete file-set BEFORE touching anything, then prove afterwards that the
realized diff matches that commitment. Anything outside the declared set is a
violation — surface it, never absorb it.

## Protocol

1. **Declare.** Write the exact file-set the change may touch — concrete repo
   paths, no globs, no "and friends". State it in the transcript (or the task
   plan) before the first edit:
   `declared: ["extensions/orchestration-engine/tier-map.ts", "README.md"]`
   If you discover mid-edit that another file genuinely must change, STOP,
   revise the declaration explicitly (say why), then continue. A revised
   declaration is a decision, not a patch to the record after the fact.
2. **Edit.** Make the change. The declaration bounds intent, not technique —
   edit freely inside the set.
3. **Verify.** Compare the realized change-set against the declaration:
   ```bash
   git status --porcelain        # working tree
   git diff --name-only          # unstaged diff
   git diff --name-only --cached # staged diff
   ```
   Every path in the output must be in the declared set, and the diff must not
   silently delete declared-but-untouched files either (an empty realized set
   for a declared file is a mismatch worth explaining).
4. **Violate → surface.** A file outside the declared set is a violation:
   stop, report it to the operator/brief owner with the exact path and likely
   cause (your edit, a hook, a lifecycle script, a build artifact). Never
   silently absorb it (commit it, revert it, or gitignore it just because).
   Absorbing a violation defeats the whole pattern — the point is that
   unexpected writes become visible.

## Worked example (runnable end-to-end)

In a clean git checkout, fix a typo in one file with a one-file declaration:

```bash
# 1. Declare (before any edit):
#    declared: ["README.md"]

# 2. Edit — the bounded change:
sed -i 's/Recieve/Receive/' README.md

# 3. Verify — realized vs declared:
git status --porcelain
# expected: exactly " M README.md" and nothing else
git diff --name-only
# expected: README.md

# 4. If anything else appears (e.g. " M package-lock.json" from an
#    npm lifecycle script), that is a violation: stop and surface it —
#    do not commit, revert, or gitignore it without saying so.
```

## Why a skill (fitness note)

Bounded-edit failures are the fleet's recurring defect class: hooks and
lifecycle scripts write behind the worker's back, and compaction summaries
lose "which files were in scope". The assertion turns scope from a promise
into a checkable contract — `git status --porcelain` output vs a written set,
mechanically comparable, no judgment needed at verify time.

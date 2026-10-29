---
name: review-vectors
description: |
  The fleet's standing review-vector list and trigger doctrine for code-review
  rounds on fleet ships (Factory Manifest Phase 2). Defines WHICH focused
  review vectors exist, WHEN a per-vector review round runs (trigger-gated,
  stakes-matched — never ritual), and HOW it composes with the review-loop
  skill (one fresh-context reviewer per triggered vector, reviewer/fixer
  isolation, narrow re-gates). Load when planning or running a review round
  for a behavior-bearing ship, when the captain asks for "the vectors" or a
  per-vector review, or when a ship's brief names review as required. Do NOT
  use for single one-pass reviews (use reviewer directly), security-only
  reviews (security-reviewer), or trigger-gated Oracle/plan reviews (those
  precede implementation; this skill reviews landed work and pre-merge diffs).
---

# review-vectors — the fleet's standing review vectors (Factory Phase 2)

Adversarial review runs per-vector: one focused reviewer per quality vector,
never one mega-reviewer with many topics (a many-topics reviewer gets lost
easier). The fan-out machinery is the review-loop skill's Mode A; this file
owns the vector list, the trigger doctrine, and the composition contract.

## The seven fleet vectors

Each reviewer gets ONE vector, the diff, and the captain's intent (the brief's
intent section verbatim). Findings carry file:line and the smallest safe fix.

1. **Correctness & regressions** — does the change satisfy the intent
   verbatim, preserve existing behavior, handle edge cases, and avoid hidden
   runtime failures? Trace the actual code paths, not the claims.
2. **Tests & validation** — do assertions encode real intent (not the
   implementer's interpretation), and are the verification commands sufficient
   to prove the stated outcome? Flag tests that mirror implementation.
3. **Simplicity & maintainability** — is this the smallest safe change? Any
   scope creep beyond the brief, duplicate structure, brittle abstraction, or
   dead machinery added "while here"?
4. **Security posture** — secret exposure, injection surface, permission
   boundaries, destructive-path safety, untrusted-content handling. Any
   finding here escalates immediately, never batches.
5. **Docs honesty** — do claims match reality (counts, paths, versions,
   current-state vs dated history)? Would a future reader be misled?
6. **Shell safety** — non-interactive flags on anything that can prompt,
   correct quoting, bounded operations (no unbounded hangs), guarded cleanup.
7. **Quota discipline** — is the seat economics right for the work (flash
   first), and does the change avoid ritual re-runs and meter blindness?

Vectors 1-3 are the review-loop defaults; 4-7 are the fleet additions. A
triggered round runs only the vectors the stakes name — never all seven by
default (that is ritual, not rigor).

## Trigger doctrine (stakes-matched, never cadence)

Run a per-vector round when ANY of:
- the ship is behavior-bearing (changes how existing machinery acts),
- the ship is factory/harness machinery (the instruments themselves),
- the diff touches security posture, trust boundaries, or destructive paths,
- the captain or the brief names review as required,
- a review-era corpus question is open (finding-dedup gate).

Skip for: trivial mechanical flips (path fixes, one-line re-anchors) already
verified by direct inspection, docs-only edits with mechanical checks, and
anything whose worst case is a localized fixable mistake. When skipped, say
so in the delivery report — a deliberate skip is a decision, not an omission.

## Composition contract with review-loop

- Fan out via review-loop Mode A: one dispatch per triggered vector, same
  turn, fresh contexts, each reviewer read-only.
- Reviewer/fixer isolation: reviewers never fix; fixes return to the
  implementer (or a narrow-writer), then ONLY the vectors that found issues
  re-review (narrow re-gate, 3-round cap as review-loop governs).
- The parent synthesizes per-vector findings into one report for the captain:
  vector, finding, smallest safe fix, severity. Security findings lead.
- Findings become fix-waves, not interleaved edits — one batch per round.

## Relationship to the other judgment layers

This skill reviews WORK (diffs, landed changes). Oracle second opinions
review PLANS and priorities (trigger-gated, earlier in the loop). Jev
pre-annotates suite-red RESIDUALS at triage time. The suite-red classifier
classes test failures. Four instruments, four stages — none consumes
another's output as a verdict; the captain arbitrates everywhere.

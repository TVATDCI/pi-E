---
description: Draft a design/plan BEFORE implementing (non-trivial changes)
argument-hint: "<what to build/change>"
---
Design doc first — do NOT write code yet. For: $@

Produce a plan with these sections, grounded in actual file reads (cite file:line for every load-bearing claim):

1. **Goal** — what problem this solves, one paragraph.
2. **Current state** — what exists today (verified by reading the modules, not assumed).
3. **Approach** — the design, with alternatives considered and why rejected.
4. **Files to touch** — every file, with the nature of each change.
5. **Risks & couplings** — what could break, what depends on this.
6. **Verification plan** — how we'll empirically prove it works (not prose-review).

Then STOP and present the plan for explicit go. Scope-it and implement-it are separate turns.
If the request is trivial (typo, one-line fix), say so and implement inline instead.

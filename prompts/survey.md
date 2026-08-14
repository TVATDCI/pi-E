---
description: Coverage-first capability survey of the extension stack
argument-hint: "[area to survey]"
---
Survey ${@:-the extensions stack} — coverage-first, NOT hook-first.

Methodology (the corrected version — a bare-hook inventory is structurally blind):

1. **Capability matrix first.** For each module: what does it DO, what's half-built (documented
   TODOs, deferred halves, dormant-but-wired pieces), what's complete. Read the files.
2. **Then** note unused pi surfaces — but every "greenfield/unexplored" claim must be
   cross-referenced against the capability matrix before it can be labeled or ranked.
   "Unused hook" ≠ "new capability."
3. **Completion items outrank novelty items.** Half-built subsystems (a deferred fallback
   chain, an unwired gate, an unadopted primitive) are usually higher-leverage than new
   surfaces.
4. Rank with effort (S/M/L) + file:line evidence for every claim. No ranking without evidence.

---
name: session-branching
description: Suggest `/fork` before a risky refactor or speculative experiment.
user-invocable: false
metadata:
  internal: true
---

## Branching

Before a risky refactor, a large speculative change, or a "let me try this" experiment, suggest `/fork` — full history stays in the JSONL and `/tree` revisits any earlier point — so the trunk stays clean and the attempt is reversible.

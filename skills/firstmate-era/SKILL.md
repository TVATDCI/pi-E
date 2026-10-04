---
name: firstmate-era
description: Firstmate-era (2026-10) fleet routing for project execution and cross-desk action — crews/worktrees/PRs via ~/firstmate, ask-first on unknown surfaces, three-party comms, pushes as the captain's word, receipt+md5+pane-kick writes.
user-invocable: false
metadata:
  internal: true
---

- **Routing:** project execution goes through firstmate (~/firstmate, ADR-0009) — crews, worktrees, PRs, supervision. Console pi = daily driver + captain-level system thinker. Firstmate owns the loop; console owns the rulings; fleet gates judge; the captain rules everything.
- **Ask-first:** when not sure about any surface of this stack — search the source, ask the captain, or ask the console — **never assume and implement**.
- **Comms:** three-party — captain through firstmate; firstmate may ask console anything; rulings/doctrine = captain only.
- **Writes:** pushes are the captain's word alone (statement of intent ≠ order; full-sync orders carry push authorization). Cross-desk agent writes = receipt + md5 + pane kick in the same turn. pi never writes bd / ~/.pi (foreign) / ~/.sisyphus / Main-vault.

---
name: corroboration
description: B3 fleet-doctrine promotion mechanics — an INFERRED fact (agent-read) becomes standing FLEET doctrine only after corroboration (≥3 distinct host-namespaced sessions on ≥2 desks; operator-provenance facts exempt). Use when promoting a store.jsonl inferred fact to cross-desk doctrine, when asked about the corroboration ledger or B3 recurrence, or when reconciling desk-local memory vs fleet truth.
---

# B3 corroboration (fleet-doctrine promotion floor)

An INFERRED fact becomes standing FLEET doctrine only after corroboration: **≥3 distinct host-namespaced sessions on ≥2 desks.** Operator-provenance facts are exempt — the human ruling IS the recurrence.

Mechanics: `node ~/dotfiles/scripts/corroborate.mjs sight|check --key <slug>`

- `sight` — record this session's sighting of the fact under its slug.
- `check` — query the ledger for a slug's corroboration status.

Ledger: `~/operator/corroboration/` — the fleet-truth layer for operator rulings and doctrine, synced cross-desk by dotfiles' corroboration-lane-sync. Memory stores stay desk-local by design; only the ledger is fleet-truth.

Divergence contract (when desks' self-models disagree): firstmate's `data/learnings.md`.

## Extracted from AGENTS.md (one-line pointer remains there)

- **Spine scope:** memory stores are desk-local by design; the B3 corroboration ledger (`~/operator/corroboration/`, synced cross-desk by dotfiles' corroboration-lane-sync) is the fleet-truth layer for operator rulings and doctrine — full divergence-contract note lives in firstmate's `data/learnings.md`.
- **B3 recurrence floor:** fleet doctrine promotion needs corroboration first — ≥3 distinct host-namespaced sessions on ≥2 desks (operator-provenance facts exempt: the human ruling IS the recurrence); mechanics live in the `corroboration` skill.

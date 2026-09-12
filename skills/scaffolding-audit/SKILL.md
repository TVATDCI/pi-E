---
name: scaffolding-audit
description: |
  Audit prompt/skill scaffolding for stale model claims when models or plans change —
  the 9-step-harness Step-9 pruning gap, closed. Runs a deterministic 5-class scan
  (historical model identifiers, workaround prose, era-pinned quota constants,
  doctrine residue, dated knowledge) over pi's routing surfaces, a doctrine diff
  anchored to the last audited commit, a manifest-diff drift check, and composes the
  existing model-audit skill for the live-endpoint leg. Read-only and propose-only:
  flags carry file:line + class + verbatim quote + suggested action; the operator
  arbitrates every change. Triggers: "scaffolding audit", "stale scaffolding",
  "audit routing text", "model changed what's stale", "drift check", "routing state
  drifted", "run scaffolding-audit". Do NOT use for: live endpoint/plan verification
  (model-audit's domain — this skill invokes it, never reimplements it), skill-set
  gap/overlap maps (skill-auditor), applying any edit it proposes (propose-only), or
  opencode/sis-side surfaces (the config-repo twin's domain).
---

# Scaffolding Audit (pi landing)

Steering surface for model/plan churn: routing text executes constantly, but nothing
audited it on change. This skill is that audit. Posture first, always:

## Hard rules

- **Propose-only (INV-1).** Every flag is a suggestion with evidence. This skill never
  deletes, edits, or applies anything — the only permitted writes are its own state-dir
  manifest (only via the explicit non-dry `manifest.ts` run) and stdout.
- **Read-only by default.** `scan.ts` and `drift-check.ts` never write. Run them with
  `deno run --allow-read` — the permission grant itself proves the read-only posture.
- **Scope mode is invocation-selected, never auto-detected (AC-8).** `--scope=full` or
  `--scope=diff` must be supplied explicitly; without it the scan exits with a usage
  error. No code path guesses model-change days from ambient state.
- **Never read, print, or write anything from `~/.pi/agent/auth.json`.** The
  live-endpoint leg belongs to `model-audit`; this skill only invokes that skill.
- **Vocabulary authority is the vendored spec** at `spec/spec-shared.md` (shared with
  the sis twin, hash-pinned per OPEN-1). Never re-define or re-word the five classes
  locally. Every audit starts with the audit-time hash-identity check (§ Vendoring).

## Audited surfaces (self-enumerated)

1. `extensions/orchestration-engine/tier-map.ts`
2. `AGENTS.md` (model-selection + judging-node sections)
3. `skills/*/SKILL.md` — enumerated at run time (never a hardcoded count), excluding
   this skill's own dir (self-exclusion: its docs legitimately quote specimens).

## Workflow

1. **Hash-identity check** (OPEN-1): `spec.ts` hashes the vendored spec; when the twin
   copy is reachable, hashes must match — mismatch = hard stop (divergence, AC-13).
2. **Drift check** (cheap leg, manifest-diff only — INV-2):
   `deno run --allow-read scripts/drift-check.ts` — opens ONLY the state manifest +
   tier-map assignments; prints the single reminder flag
   `routing state drifted since last audit — run scaffolding-audit` when stale or
   never-audited; silent when fresh; never writes.
3. **Scan** (invoked leg):
   `deno run --allow-read --allow-run=git scripts/scan.ts --scope=full`
   (diff-scope needs a manifest anchor: `--scope=diff`). Emits the flag report +
   doctrine-diff section to stdout. Deterministic: no network, no model calls, no
   wall-clock fields in the report.
4. **model-audit leg (composed, D4).** Invoke the existing `model-audit` skill for the
   live-endpoint triangle and embed its output VERBATIM in the report. If unavailable,
   record a noted-missing leg — the text audit still completes (no hard failure).
5. **Report.** Every flag: `file:line` + class (1–5) + verbatim quote + suggested
   action (always begins `PROPOSE ONLY — operator arbitrates:`) + finding hash.
   First live reports go to the operator — arbitration is the standing steering
   mechanism.
6. **Record (explicit non-dry only).** `deno run --allow-read --allow-write=<state-dir>
   scripts/manifest.ts --scope=full` — runs the scan and writes
   `state/manifest.json` (recorded-at, surface-scope, last-audit-commit, model-state,
   finding-hashes per the vendored spec §3). Never at session start; superseded by
   each new audit; no cleanup job.

## Session-start drift wiring (OPEN-2 ruling)

pi's existing `session_start` extension point may invoke the read-only check:

```
deno run --allow-read ~/.pi/agent/skills/scaffolding-audit/scripts/drift-check.ts
```

Zero writes, O(manifest), at most one stdout reminder line. The extension-point edit
itself is operator-owned (this skill never edits `extensions/`).

## Vendoring (OPEN-1)

`spec/spec-shared.md` is byte-identical across both landings; the twin's staged copy
rides the plan evidence dir until the twin lands. Divergence = hard audit failure.
Class/extensions are made in the spec and re-vendored to both landings in one change.

## Classification source

The deterministic rule table lives IN the vendored spec (`<!-- sca-rule-table-v1 -->`
JSON block) — both landings parse the same table, so classification cannot diverge.
Deterministic scan entry point: `scripts/scan.ts` (required by the cross-landing
divergence test; never LLM-judged).

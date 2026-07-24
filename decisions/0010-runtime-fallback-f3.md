# Decision 0010 — F3: runtime retry with cross-provider fallback on empty output

**Status:** IMPLEMENTED — 2026-07-11
**Date:** 2026-07-11
**Trigger:** Operator hit silent empty responses from Z-AI Coding Plan tiers after weekly quota exhaustion. F4's availability precheck only handled missing keys, not exhausted quota.
**Pi version:** 0.80.5

> **Re-verify (2026-07-16 · pi 0.80.8):** F3 lives in `spawn.ts`/`orchestration-engine` → **compiles clean** on 0.80.8. The dispatch spawn path works (a `quick` dispatch completed successfully on 0.80.8). F3's empty-output retry / cross-provider fallback logic was **not** directly exercised this pass (would require simulating quota exhaustion).
**Builds on:** `tier-map.ts` (TIERS, FALLBACK); `spawn.ts` (`resolveAndSpawn`); `routing-stats.ts` (source-aware views); Decision 0005 (F4 availability precheck).

## The problem (F3)

Decision 0005 added a pre-check for missing API keys (`registry.getAvailable()`), but it does **not** detect quota exhaustion. Z-AI Coding Plan calls have no balance fallback (FAQ:66-69), and when the weekly quota is exhausted the model can return an empty response with exit code 0. The operator observed this on `persona-forge evolve reviewer`: every step produced `CODE: 0, LEN: 0`.

The prior `FALLBACK` (`opencode/glm-5.1`) was only used when the chosen model was **unconfigured** (missing key), not when it was configured but exhausted. This left the operator with no automatic recovery path.

## The decision

1. **Per-tier fallback providers in `tier-map.ts`**: every Z-AI-plan category now carries an explicit `fallbackProvider`/`fallbackId` pointing to the opencode equivalent. The `git-commit-message` category is already opencode-primary and needs no fallback.
2. **Runtime empty-output retry in `resolveAndSpawn`**: after the primary model returns an empty response, if the tier's fallback is available, retry the same task with the fallback model. If the fallback also returns empty, fail with a clear message about quota.
3. **Loud observability**: both `downshift-unavailable` (F4) and `downshift-exhausted` (F3) are logged in `dispatch-log` and surfaced by `/routing-stats`.
4. **Fallback targets for v1**: high-effort tiers (`unspecified-high`, `deep`, `ultrabrain`, `visual-engineering`, `artistry`) fall back to `opencode/glm-5.1` (the same model as the global `FALLBACK`). Low-effort tiers (`quick`, `unspecified-low`, `writing`) fall back to `opencode/deepseek-v4-flash-free` (FREE) because short tasks, routine low-effort work, and prose/docs do not need flagship-class reasoning.

> **_[Footnote 2026-07-11 — fallback targets refined after this ADR was written.]_** The v1 fallback targets above were refined the same day (commit `906d934` and a follow-up) to use **per-tier** FREE/cheaper targets rather than a uniform `glm-5.1`/`deepseek-free` split. Current per-tier fallback map (source of truth = `tier-map.ts`):
> - `quick` → `opencode/deepseek-v4-flash-free` (FREE)
> - `unspecified-low` → `opencode/hy3-free` (FREE)
> - `writing` → `opencode/hy3-free` (FREE)
> - `unspecified-high` → `opencode/kimi-k2.7-code`
> - `deep` / `ultrabrain` / `visual-engineering` / `artistry` → `opencode/glm-5.1`
>
> This makes the "Out of scope (deferred) → fine-grained per-tier fallback targets" item below **no longer deferred — shipped 2026-07-11, operator-tested with all Z-AI tiers exhausted.** The ADR body above is preserved as the original decision record; the live config lives in `tier-map.ts` + `README.md`.

## Why this is the minimal F3 implementation

- The failure mode is **empty output, not a thrown error**, so we cannot rely on exception-based retry.
- The retry is **per-dispatch**, not inside a loop, to avoid runaway cost: one primary attempt, one fallback attempt, then fail.
- The fallback is **provider-level**, not just model-level: it switches from `zai-coding-cn` to `opencode`, which is the only other provider configured for this system.
- We deliberately keep the same `thinkingLevel: "high"` for fallback attempts to maximize the chance of useful output on the one retry.

## Out of scope (deferred)

- **Fine-grained per-tier fallback targets** (e.g., `unspecified-low` → `opencode/deepseek-v4-flash-free`). Will revisit once `/routing-stats` shows how often each tier falls back.
- **Quota-aware pre-emption** (checking remaining quota before dispatch). The registry does not expose quota counters; the empty-output heuristic is the pragmatic signal available today.
- **More than one retry** — intentionally one fallback attempt to prevent silent runaway spend.

## Verification

- ⏳ `tsc --noEmit` — blocked in this environment; type changes are minimal (optional `fallbackProvider/fallbackId` on `TierEntry`, optional `fallbackFlag` on `ResolvedModel`, `source: string` in `SpawnResult` already permissive).
- ⏳ Live (operator): run `/persona-forge evolve reviewer` after Z-AI quota is exhausted; each step should now fall back to `opencode/glm-5.1` and produce non-empty output, logged as `source: "downshift-exhausted"`.

## Files changed

- `extensions/orchestration-engine/tier-map.ts` — added `fallbackProvider/fallbackId` to `TierEntry`, `fallbackFlag` to `ResolvedModel`, populated per-tier fallbacks.
- `extensions/orchestration-engine/spawn.ts` — added empty-output retry path in `resolveAndSpawn`.
- `extensions/orchestration-engine/routing-stats.ts` — surfaced `downshift-exhausted` in the routing-source view and flags.
- `README.md` — documented the fallback column and the two downshift sources.

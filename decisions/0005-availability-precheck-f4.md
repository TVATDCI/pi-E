# Decision 0005 — F4: availability precheck + downshift (+ `/tiers` setup command)

**Status:** IMPLEMENTED (v1) — 2026-07-09
**Date:** 2026-07-09
**Trigger:** Phase 1. The operator's model-switching/testing workflow upgrades availability from "defensive insurance" to a **setup concern** — knowing which models have a configured key is core, not optional.
**Pi version:** 0.80.3

> **Re-verify (2026-07-16 · pi 0.80.8):** `orchestration-engine` (F4 `getAvailable()` precheck + `/tiers`) **compiles clean** on 0.80.8. The `/tiers` command + live availability logic were **not** re-exercised (needs interactive session); extension loads at boot.
**Builds on:** `orchestration-engine/index.ts` (execute + spawnSub); `tier-map.ts` (TIERS, FALLBACK); `routing-stats.ts` (source-aware views).

## The problem (F4)

`resolveModel` used `registry.find(provider, id)`, which returns a model if it is **registered** — but does NOT check whether it has a configured API key (`docs/sdk.md:383`: *"doesn't check if API key exists"*). So a dispatch could pick a model, spawn a full subprocess, and only discover the missing key at spawn-exit. While switching models to test them, this is a recurring trap, not a rare one.

## The decision

1. **Availability precheck at route time** via `registry.getAvailable()` → `Model<Api>[]` (models with configured auth; `docs/sdk.md:386`). `find` = registered; `getAvailable` = has a key.
2. **Auto-downshift, loud**: if the chosen model lacks a key, fall back to `FALLBACK` (glm-5.2) so the dispatch still runs — but NOTIFY the operator and log `source: "downshift-unavailable"` + `downshiftedFrom`. **Never silent substitution** (critical for a testing workflow, where a silent substitute corrupts results).
3. **Abort cleanly** if both the chosen model AND `FALLBACK` are unavailable, pointing to `/tiers`.
4. **`/tiers` command** — the setup tool: the 9 categories × model / thinking / quota× / **REAL availability** (✓ yes / ✗ NO KEY). Run before switching models.

## Refactor — single resolution point

Model resolution (tier-map default → persona override → F4 availability downshift) now happens **once in `execute()`** and is passed to `spawnSub` as `resolved`. Previously both computed it independently (duplication). `spawnSub` now just runs what it's given.

## Observability (extends F6)

`routing-stats.ts`'s routing-source view is now **dynamic** (groups by whatever sources exist, including `downshift-unavailable`), and a new flag fires: `⚠ N dispatches downshifted (chosen model unavailable) — run /tiers`. So `/routing-stats` surfaces availability-driven downshifts alongside the existing footgun flags.

## Out of scope (deferred)

- **Category-aware downshift targets** — currently `FALLBACK` (glm-5.2) for all. A git-commit (meant FREE) falling to flagship is overkill; category-specific targets are a future refinement, informed by `/routing-stats` downshift data.
- **`getAvailable()` caching** — called per-dispatch (sync, cheap). Add per-session caching only if dispatch latency suffers (design doc §8-Q1).
- **Strict-fail mode** — currently always downshifts (resilience). An "abort instead of substitute" flag is possible if testing demands it.

## Verification (executed 2026-07-09)

- ✅ `tsc --noEmit` — 0 errors (`getAvailable()` + `Model.provider/id` access typecheck).
- ✅ Seed test — 15/15 (added `downshift-unavailable` source + flag assertions; dynamic routing-source view renders).
- ⏳ Live (operator): `/tiers` renders the 9 categories with real ✓/✗; a dispatch against an unconfigured model notifies + logs the downshift.

## Why this is the right Phase 1 (and why F2 wasn't)

Inspection (Decision-0004 probe + this one) showed F2's value was already covered by `/routing-stats` (peak/promo → `quota×`) and its routing-time downshift is moot for the operator's schedule (works outside peak; promo active through Sep 30). F4 is the *live* footgun for an active model-switching workflow — worth building now. The stale-pin audit (same probe) returned clean: 0 of 8 personas carry a `model:` pin. _[Editorial note 2026-07-09: persona count is now **7** — `scout` merged into `explore` (commit `bf8a3d4`); the "0 pin" finding is unchanged.]_

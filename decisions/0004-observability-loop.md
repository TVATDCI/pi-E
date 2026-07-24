# Decision 0004 — Observability loop: `/routing-stats` reads back the dispatch-log (F6)

**Status:** IMPLEMENTED (v1) — 2026-07-09
**Amendment (2026-07-09):** v1 scope upgraded **session-scoped → cwd-scoped** (cross-session). The first live run returned 0 entries (this session had no dispatches) — exactly the "informed by v1 usage" trigger the ADR had deferred on. Read layer now uses `SessionManager.list(ctx.cwd)` + `parseSessionEntries` over every session in the current project (single-session fallback on failure). Verified on real data: 6 entries across 19 sessions for `/home/vladi/.pi`. `routing-stats.ts` pure helper unchanged; `tsc` clean; seed test 13/13. Global (`/routing-stats all`) still deferred.
**Date:** 2026-07-09
**Trigger:** Approved optimization strategy (machinery-first). F6 = Phase 0 — prerequisite for every later phase (per `3-LAYER-ROUTING-DESIGN.md` §8-Q2) and the mechanism that turns borrowed config into owned, tunable config.
**Pi version:** 0.80.3

> **Re-verify (2026-07-16 · pi 0.80.8):** `orchestration-engine` (where `routing-stats.ts` + the read layer live) **compiles clean** on 0.80.8 — the only `tsc` errors are in `memory/` and `web-research.ts` (see ADR 0011/0012), unrelated to this ADR. The `/routing-stats` TUI command itself was **not** re-exercised (needs interactive session); extension loads at boot.
**Builds on:** existing `pi.appendEntry("dispatch-log", {…})` in `orchestration-engine/index.ts`; design spec in `3-LAYER-ROUTING-DESIGN.md` §4 + §6.

## The problem (F6)

The dispatch tool writes a rich `dispatch-log` entry per dispatch — but **nothing reads it back.** Observability is write-only:
- The operator cannot see "category X fails Y% on model Z," so empirical model-tuning (the ownership goal) is impossible.
- Silent mis-routes stay invisible until they bite (the 2026-07-08 `builder.md` cost-tier override hit 8/9 categories before anyone noticed — by reading code, not behavior).
- Every later phase (F2/F3, owned-persona design) needs this data to sequence itself. F6 is the design doc's own stated prerequisite (§8-Q2: *"instrument current dispatches before deciding on L1"*).

## Probe results (pre-build, 2026-07-09 — read-only, no pi code)

- **API validated.** Real entries serialize as `{customType:"dispatch-log", data:{…payload…}, id, parentId, timestamp, type:"custom"}`. Read path confirmed against `docs/extensions.md:1413` + `:947` and the live session JSONL: `ctx.sessionManager.getEntries()` filtered by `entry.type === "custom" && entry.customType === "dispatch-log"`, payload under `entry.data`. The design doc's assumption holds exactly.
- **Volume: 11 real entries across 76 sessions** (3 days). Mostly build-along test traffic, not real usage.
- **Value proven at low n.** The builder pin problem was empirically visible in 11 entries (builder = 83% override; 45% of all dispatches overridden). **Footgun detection works at n=11; model-fit tuning does not** (needs real volume).

## The decision

Build a **read-only** `/routing-stats` command. v1 = four views + `quota×` column + dumb-threshold flags. No new logging, no model changes, no spawn-logic changes, no behavior change to `dispatch`.

## Spec

**Registration:** `pi.registerCommand("routing-stats", { description, handler })` in `orchestration-engine/index.ts`.

**Read source:** `ctx.sessionManager.getEntries()` → filter `type === "custom" && customType === "dispatch-log"` → `entry.data`.

**Output:** `ctx.ui.notify(headline, "info")` (one-line summary + flag count) + `ctx.ui.editor("/routing-stats", table)` (full multi-line table). `ctx.hasUI` guard; `console.log` fallback in print mode.

**Views (over existing fields `category, modelFlag, source, agent, outcome, elapsedMs`):**
- per-category: n, fail%, top model, p50/p95 elapsedMs
- per-model: n, fail%, p50/p95, `quota×` (FREE for opencode; 1×/2×/3× for glm-5.2/5-turbo via `isPromoActive`/`isPeakHours`; 1× otherwise)
- per-agent (persona): n, override%, fail%
- routing source: tier-map vs persona-override share

**Dumb flags (conservative thresholds, computed from the aggregates):**
- category fail% > 25% with n ≥ 3 → "⚠ <cat> fails X% on <model>"
- agent override% = 100% with n ≥ 2 → "⚠ <agent> overrides 100% — check its .md `model:` pin"
- persona-override share > 30% → "⚠ high override rate"

**Pure helpers exported for testability:** `aggregateDispatchLog(entries, {peak, promo})` + `DispatchLogEntry` interface.

## Out of scope (deferred)

- `usage`/cost fields — not captured in `index.ts` yet (no token parsing); arrives with L2/L3 work.
- **Cross-session persistence** — v1 is session-scoped. The probe showed model-fit tuning needs real volume that spans sessions; the mechanism (dedicated append-only log vs `bd` audit) is decided later, informed by v1 usage. **Flagged follow-up, not v1.**
- Smart/LLM flags — that's F1 (intent classifier), gated on §8-Q2 measurement.
- Full 3-layer `RouteDecision` schema (§6 target) — v1 reads today's flat schema.

## Verification (executed 2026-07-09)

- ✅ `tsc --noEmit` — 0 errors across the agent project (my files included).
- ✅ Deterministic seed test (`test-routing-stats.ts`, 13 assertions) — 13/13 pass; table renders; flags fire on deep 67% / builder 100% / override 44%; no false positive on clean `quick`; quota matrix correct. Run: `node --experimental-strip-types test-routing-stats.ts`.
- ✅ Extension-discovery safety confirmed (`docs/extensions.md:116-119`): pi auto-loads `extensions/*/index.ts` only, so `routing-stats.ts` / `test-routing-stats.ts` are imported/standalone, never auto-loaded at startup.
- ⏳ Live acceptance (operator): `/reload` then `/routing-stats` — renders this session's real dispatch-log entries.

## Why this is the right Phase 0

- **Ownership mechanism** the operator asked for ("learn behavior → pick model empirically") — without it, model choices stay inherited from OmO.
- **The design doc's own prerequisite** (§8-Q2) for sequencing F1/F2/F3.
- **Cheap + reversible** — read-only, no behavior change, no deps.
- **Retroactively makes the existing dispatch-log valuable** instead of write-only.
- **Catches the next footgun live** — the builder finding proves override/cost anomalies surface even at low volume, so the smoke detector is in place before the next fire.

## Live finding (from the pre-build probe — separate action item)

The probe confirmed the `builder.md` override problem in real data (builder 83% override, 5/6 dispatches). The 2026-07-08 removal was justified. **Action: verify no other persona `.md` carries a stale `model:` pin** — builder was not necessarily alone. (Orthogonal to this ADR; tracked separately.)

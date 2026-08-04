# Pi Handoff — align tier-map.ts model docs to the 4-model Z AI Coding Plan (2026-08-04)

**Written at:** 2026-08-04T00:20:00Z
**Pi session:** 019fc9fd-5b5f-79d0-ae48-22c623a77c9c
**Original intent:** Map the operator's tier-map.ts model changes and align every dependent document; then record *why* after the operator discovered the Coding Plan narrowed to 4 callable models.

## Summary
The operator changed three primaries + several per-tier fallbacks in `tier-map.ts` (quick→FREE opencode, deep/artistry→glm-5.2). I derived the delta by comparing `tier-map.ts` against the README/HANDOFF "before" tables (no git diff available — see Dead ends), then aligned 9 files: living docs updated in place (README table+prose, the load-bearing `index.ts` dispatch-description string, review-loop SKILL, tier-map rationales+top comment) and historical docs given dated addendum footnotes (HANDOFF, ADRs 0007/0009/0010, 3-LAYER-ROUTING-DESIGN). When the operator revealed the *why* (Coding Plan now allows only 4 models), I recorded it in the tier-map `PLAN NARROWED 2026-08-04` block + rationale strings + memory.

## Files touched
- `agent/extensions/orchestration-engine/tier-map.ts` — operator changed ids/fallbacks; I aligned 4 stale `rationale` strings to their ids, rewrote the map header (8→7 of 10 Z-AI-plan-primary), 2 type comments, and added the dated `PLAN NARROWED` doc block (the *why*). Date was corrected 07-25→08-04.
- `agent/README.md` — category→model table (10 rows) + prose line aligned to the new map.
- `agent/extensions/orchestration-engine/index.ts` — dispatch-description string (injected into every dispatch prompt — load-bearing) aligned.
- `agent/extensions/orchestration-engine/3-LAYER-ROUTING-DESIGN.md` — dated re-verify footnote on the now-stale per-tier fallback targets.
- `agent/extensions/orchestration-engine/HANDOFF.md` — dated addendum footnote with the delta (original 07-08 table + 07-13 footnote preserved).
- `agent/decisions/0010-runtime-fallback-f3.md` — dated footnote superseding the per-tier fallback map.
- `agent/decisions/0009-persona-forge.md` — dated footnote correcting `ultrabrain → glm-5.1` to `→ opencode-go/kimi-k3` (was already stale pre-session).
- `agent/decisions/0007-team-selector.md` — dated footnote on the `quick → glm-4.5-air` verification step.
- `agent/skills/review-loop/SKILL.md` — tier/model cheat line aligned.

## Decisions made
- **Why deep/artistry→glm-5.2, quick→FREE opencode:** the Z AI Coding Plan narrowed to 4 callable models (glm-5.2, glm-5.2-highspeed, glm-5-turbo, glm-4.7); glm-5.1 and glm-4.5-air were dropped. deep/artistry had to leave 5.1 (5.2 is the remaining flagship reasoning model); quick had to leave 4.5-air and trivial work isn't worth the remaining on-plan quota → FREE external. Recorded durably.
- **Historical docs get footnotes, living docs get rewrites** — per the existing `historical_doc_edits_as_footnotes` rule; ADRs/HANDOFF/PROBE-RESULTS keep their audit trail, README/index.ts/SKILL/tier-map are corrected in place.
- **Left PROBE-RESULTS.md + test-routing-stats.ts alone** — the former is point-in-time probe evidence ("do not rewrite"); the latter are synthetic fixtures, not docs.

## Dead ends
- **No git diff to map the change.** `~/.pi` is not a repo (the repo is `~/.pi/agent`); I initially checked the wrong dir and found no history. Fell back to using the README + HANDOFF tier tables as the "before" snapshot, which worked cleanly.
- **Standalone `tsc` on `index.ts` spilled ~20 errors** (missing `@earendil-works/pi-coding-agent` module, node types, `.ts` import extensions) — recognized these as pre-existing environment errors from compiling in isolation without the project tsconfig, NOT from my string-literal edit. Relied on `tier-map.ts` standalone (clean) + the fact that the index.ts edit was a pure string swap.
- **Near-miss (caught): wrong date.** I labeled everything `2026-07-25` — copied from the bridge export timestamp, not the real session date. Caught at close (real date 2026-08-04) and globally corrected across all 7 affected files + both memory fact keys before commit. Lesson for future: the bridge `[FROM bridge, exported …]` timestamp is sisyphus's export time, NOT this session's date — use the real current date.

## Incomplete work
- **(b) deferred:** optionally adopt `glm-5.2-highspeed` (faster 5.2 variant, newly on-plan) for a latency-sensitive tier (deep/visual-engineering). Operator deferred — model churn is too high to tune right now.
- **High model churn** (industry flips every 3-4 days, per operator): the 4-model set will need re-verification within days; the *reasoning* is now durable, only specific ids will need refreshing.

## Proposed bd facts
<pi proposes; sisyphus reviews + promotes via scripts/bd_remember.py. pi NEVER writes bd.>
- scope=global | category=exact | key=zai_coding_plan_callable_models | value="As of 2026-08-04 the Z AI Coding Plan permits ONLY 4 callable models: glm-5.2, glm-5.2-highspeed, glm-5-turbo, glm-4.7. glm-5.1, glm-4.5-air, glm-5v-turbo, glm-4.7-flashx are now OFF-plan (error 1113/1311 or empty on call). Volatile — re-verify; the model industry flips every few days."
- scope=global | category=reason | key=pi_selector_shows_catalog_not_subscription | value="pi's model selector shows the provider CATALOG (pi built-ins + ~/.pi/agent/models-store.json, a cache of Z AI's /models endpoint), NOT what the active subscription permits. Z AI /models returns the full platform catalog, so off-plan models still appear in the picker; subscription scope is enforced server-side at call time only. pi has no built-in way to grey out an off-plan model. Footgun: pi's built-in default for zai-coding-cn is hardcoded glm-5.1 (now off-plan) — avoid bare-provider fallback paths."

## Next steps for opencode
- **Re-verify the 4 callable models in a few days** — churn is high; the set above is a 2026-08-04 snapshot.
- **glm-5.2-highspeed adoption** — a pi-side tier-map decision if latency on deep/visual-engineering matters; not urgent.
- **pi built-in default `glm-5.1` footgun** lives in the pi package (`dist/core/model-resolver.js` `defaultModelPerProvider["zai-coding-cn"]`), now off-plan — not fixable from agent config; just be aware if any path resolves to the bare provider default.

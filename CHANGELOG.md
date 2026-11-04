# Changelog

Dated era/provenance record for the routing tier map (`extensions/orchestration-engine/tier-map.ts`).

**Convention** (captain ruling 2026-11-04, enforced by `extensions/tests/tier-map-comment-hygiene.test.ts`): the tier-map file carries LIVE CONSTRAINTS only, tightened to their minimal true statement. Every dated reroute story, demotion history, dashboard-verification note, and provenance cite lands HERE as a dated entry — knowledge moves, never evaporates. Future model changes: update the map, then append the story below.

## Tier-map model history

- **2026-09-03** — glm-5.3 `reasoning_effort: max` probe-verified as default + recommended for coding (pi `--thinking max` accepted; recorded in the `ThinkingLevel` type docs before the tidying round).
- **2026-09-07 / 2026-09-08** — initial operator model assignments; V2 Max reroutes. Category names/semantics and the per-category `thinkingLevel` field were ported verbatim from the oh-my-openagent `categories`/`variant` blocks (omo since retired) so the dispatch vocabulary and thinking info survived the port.
- **2026-09-08** — `unspecified-low` moved to zai/glm-5.3-flash (operator go): V2 Max 20×-Lite volume removed the Pro-era plan-credit-preservation rationale; the direct call drops the opencode-go router hop/dependency. `gpt-5.6-luna` demoted to first fallback (external diversity preserved). MCP dedicated monthly quota dashboard-confirmed ("MCP Quota 1% Used, Reset 2026-10-07").
- **2026-09-11** — V2 Max-Quarterly plan shape dashboard-verified: ~1,600 prompts/5h · ~8,000/week (20× Lite), no balance fallback. V2 grandfathered until the QUARTERLY cycle ends, then converts to the credits system (Max: 28,000/5h · 140,000/week; usage = (in×mult + cached×mult + out×mult)/10⁴; 5.3 = 6.9/1.7/24 · flash = 2.3/0.56/8; off-peak 50%; the FAQ's ×1.2-credits-per-call MCP billing applies to NEW-plan credits accounts only). Peak-window revision: the 3×-flagship/1.2×-flash multipliers DO apply on V2 Max (usage-reference table) — superseding the earlier "off-peak zai billing is flat: flagships 2×, flash 1×" reading, the "dedicated peak resources ≠ free peak usage" assumption, and the old "peak-downshift moot" note; off-peak flash floor 0.4×. FLASH-FIRST DOCTRINE operator-endorsed — production-proven by the archivist (3 captures + 2 micro-passes on flash, zero deviations).
- **2026-09-18 (Captain revision)** — ultrabrain rerouted zai/glm-5.3 → opencode-go/grok-4.6 @xhigh (glm-5.3 demoted to rung 3); deep fallbacks made glm-only cross-provider (workhorse models out of the reasoning floor); 8 of 10 categories zai-primary. security-review operator seat + glm-family-ONLY per-tier chain fixed (sis plan 2026-09-18 C2).
- **2026-11-04 (Captain trial + tidying)** — ultrabrain grok-4.7 → opencode-go/kimi-k3.1-pro @xhigh (grok-4.7 demoted to first fallback; live-proven by the oracle consults 2026-10-31 + 2026-11-03). Same day, the captain ruled the comment-tidying round: constraints tightened in-file, this changelog becomes the history home, and the comment-hygiene validator makes regrowth fail the suite.

### Undated provenance moved 2026-11-04 (preserved verbatim in spirit)

- **security-review tool pin** hoisted from chain-runner's F1 reviewer toolsOverride to category level (sis plan §1.1, C3/T2).
- **STRONG_FLAGSHIP_RE** extracted as the single strong-tier source (sis review condition 2b); **luna confirmed the uniquely correct global tail** (sis R3-review findings 3 + 4 — self-dedupe would silently cancel the global tail on apex judging categories).
- **`tierEntryFor` guard** surfaced by review-loop S1 (unguarded `TIERS[category]` path).
- **Luna reachability claim as written in the R3 note**: "proven reachable (unspecified-high rung-2)" — rungs shifted since; at sweep time luna sits rung-1 in the quick / unspecified-low / writing / research / git-commit-message chains. The stale claim was not carried into the file.
- **Dead pointers deleted**: "MODEL TIERING" (no such doc), STRONG_FLAGSHIP_RE's stale line-number ref `(:45-47)`, "helpers kept for a possible post-conversion future" fragment, "(dashboard books consumption…)" wording.

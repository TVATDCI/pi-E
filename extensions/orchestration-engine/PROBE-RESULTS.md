# PROBE RESULTS — Z AI Coding Plan Model Support

> **2026-07-06 resolution note (glm-5v-turbo):** The `glm-5v-turbo` row below (code 1311) is **explained and resolved — not stale.** Docs research (https://docs.z.ai/guides/vlm/glm-5v-turbo) confirmed glm-5v-turbo lives on the **STANDARD Z.AI API** (`/api/paas/v4/`, pay-as-you-go balance), NOT the **Coding Plan** endpoint (`/api/coding/paas/v4/`) that this probe tested. The Coding Plan deliberately excludes vision — so 1311 is the expected, correct result for that endpoint, and `/model` listing the model reflects catalog presence on the standard API (a different billing rail), not Coding-Plan callability. **Operator action:** switched multimodal-looker to `opencode/gemini-3.1-pro` primary (Option A — zero extra billing setup). No OmO primary now uses glm-5v-turbo; if vision-via-glm is wanted later, route via a standard-API Z.AI provider (pay-as-you-go), not `zai-coding-plan/`. The 5 text-model rows (glm-5.2/5-turbo/4.7/5.1/4.5-air) remain valid Coding-Plan facts. — The matrix below is preserved as point-in-time evidence (do not rewrite).

**Date:** 2026-07-04
**Method:** Empirical probe of `https://api.z.ai/api/coding/paas/v4/chat/completions` using the operator's plan key (read internally from `~/.pi/agent/auth.json["zai-coding-cn"].key`, never printed). Probe script: `/tmp/zai-probe.mjs`.
**Why:** Three doc sources disagreed on which models the Coding Plan accepts. FAQ:11/236 says "only GLM-5.2, GLM-5-Turbo, GLM-4.7"; latest-model guide uses glm-4.5-air; operator's `oh-my-openagent.json` uses glm-5.1, glm-4.5-air, glm-5v-turbo. Empirical test was the only way to resolve it.

## Verdict matrix

| Model | Plan status | Evidence | Action |
|-------|-------------|----------|--------|
| `glm-5.2` | ✅ **ON PLAN** | HTTP 200, returned content | Primary flagship |
| `glm-5-turbo` | ✅ **ON PLAN** | HTTP 200, returned content | Agent-loop personas (atlas, sisyphus-junior, archivist) |
| `glm-4.7` | ✅ **ON PLAN** | HTTP 200, returned content | Default mid tier (1×) |
| `glm-5.1` | ✅ **ON PLAN** | HTTP 200, returned content | Writing tier (1×) |
| `glm-4.5-air` | ✅ **ON PLAN** | HTTP 200, returned content | Cheapest plan tier (1×) |
| `glm-5v-turbo` | ❌ **NOT ON PLAN** | code 1311 "subscription plan does not yet include access to GLM-5V-Turbo" | Route vision → opencode gemini |
| `glm-4.7-flashx` | ❌ **NOT ON PLAN** | code 1113 "Insufficient balance or no resource package" | Removed from models.json |
| `glm-4-32b-0414-128k` | ❌ **NOT ON PLAN** | code 1113 "Insufficient balance or no resource package" | Removed from models.json |

## Interpretation

- **FAQ:236 ("only three") is outdated policy text.** The plan actually accepts **5 text models**: glm-5.2, glm-5-turbo, glm-4.7, glm-5.1, glm-4.5-air. The operator's `oh-my-openagent.json` routing is NOT silently failing (except vision).
- **Vision is the one real gap.** `glm-5v-turbo` returns 1311. The plan's "Vision Understanding" benefit refers to the **Vision MCP server**, not the glm-5v-turbo model directly. For vision tasks, route to opencode `gemini-3.1-pro` (already configured in auth.json).
- **Non-plan models hard-fail (no balance fallback).** Per FAQ:66-69, exhausted quota = failure; calls outside the plan "are not available." The two cheap tiers added in an earlier draft (flashx, 4-32b) are unusable on this subscription and were removed.

## Quota cost map (per FAQ:21, /devpack/overview)

| Model | Off-peak now → Sep 30 | Off-peak Oct 1+ | Peak 06:00-10:00 UTC |
|-------|----------------------|-----------------|----------------------|
| glm-4.5-air | 1× | 1× | 1× |
| glm-4.7 | 1× | 1× | 1× |
| glm-5.1 | 1× | 1× | 1× |
| glm-5.2 | **1×** (promo) | 2× | 3× |
| glm-5-turbo | **1×** (promo) | 2× | 3× |

**Berlin operator works outside 08:00–12:00 local = outside peak.** Through Sep 30, glm-5.2 and glm-5-turbo cost the **same quota as glm-4.7** off-peak. The promo window is a free capability upgrade to exploit.

## Sources cited
- `/devpack/overview` — plan tiers (Pro: 400/5h, 2000/week), multiplier policy, supported-models headline
- `/devpack/faq.md:21` — "3× peak, 2× off-peak" for glm-5.2/glm-5-turbo; promo "1× off-peak through end of September"
- `/devpack/faq.md:11,236` — "only three models" claim (contradicted by probe)
- `/devpack/faq.md:66-69` — no balance fallback; quota exhaustion = hard fail
- `/devpack/latest-model` — Claude Code config uses glm-4.5-air as Haiku default
- Empirical probe (this file) — authoritative for the operator's actual plan

---

## Q5 verification — `--thinking` per-category is safe (2026-07-04)

**Sub-check A: CLI accepts all 6 thinking values on 0.79.9.** Direct probe:
- `--thinking off` → accepted (ran)
- `--thinking minimal` → accepted (ran)
- `--thinking low` → accepted (ran)
- `--thinking medium` → accepted (ran)
- `--thinking high` → accepted (ran)
- `--thinking xhigh` → accepted (ran)
- `--thinking invalid-value` → REJECTED (parser validates against the enum)

**Sub-check B: per-model thinkingLevelMap behavior (built-in zai-coding-cn).**
- `glm-5.2`:  `off`→provider-default, `minimal`→null (skipped), `low/medium/high`→"high", `xhigh`→"max"
- `glm-4.7`:  empty map → all levels use provider defaults (no-ops, safe for `off`)
- `glm-4.5-air`: empty map → same (safe for `quick→off`)
- `glm-5.1`:  empty map → `writing→medium` sends provider default medium
- `glm-5-turbo`: empty map → safe

**Conclusion:** the spawn arg `--thinking ${resolved.thinkingLevel ?? "off"}` is fully verified end-to-end. The tier-map's per-category `thinkingLevel` (ultrabrain→xhigh, deep→high, quick→off, etc.) is safe to honor in L3.

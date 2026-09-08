/**
 * Layer 2 — category → {provider, id, thinkingLevel} tier map for the Orchestration Engine.
 * Model assignments: operator 2026-09-07, revised 2026-09-08 (V2 Max reroutes); probe evidence in PROBE-RESULTS.md.
 *
 * Category names/semantics ported verbatim from oh-my-openagent.json — they are the
 * dispatch vocabulary (prompts, skills, operator muscle memory key on them). Do NOT rename.
 *
 * ─── Z AI GLM Coding Plan (zai-coding-cn) — LEGACY PLAN V2 Max-Quarterly (dashboard-verified 2026-09-08) ──
 * Models: ALL plans run GLM-5.3 + GLM-5.3-Flash only — re-verified 2026-09-08 on BOTH endpoints
 *   (api.z.ai/api/anthropic + open.bigmodel.cn/api/coding/paas/v4, pi's endpoint). glm-5/5.1/5.2
 *   auto-route to 5.3; glm-4.5/4.5-air/4.6/4.7/5-turbo auto-route to 5.3-Flash — legacy ids below
 *   are ALIASES, not distinct pools (dashboard still BOOKS consumption by requested id).
 * glm-5.3-flash: native multimodal, thinking CANNOT be disabled — "off"/"minimal" stamps are
 *   tolerated no-ops (model reasons regardless).
 * glm-*-highspeed variants: unused by operator choice (never planned; no probe needed); store
 *   also carries dead ids glm-4.6v/glm-5v-turbo (vision, outside plan scope) — picker clutter only.
 * Quota = V2 PROMPTS (Max-Quarterly: ~1,600/5h · ~8,000/week, 20× Lite; 1 prompt ≈ 15–20 model
 *   invocations). V2 is grandfathered until the QUARTERLY cycle ends, then converts to the new
 *   credits system (Max: 28,000/5h · 140,000/week; usage = (in×mult+cached×mult+out×mult)/10⁴;
 *   5.3 = 6.9/1.7/24 · flash = 2.3/0.56/8; off-peak 50%). MCP servers (Web Search / Web Reader /
 *   Zread — wired at ~/.config/mcp/mcp.json, pi-only) run on a DEDICATED monthly quota on V2
 *   (dashboard-confirmed 2026-09-08: "MCP Quota 1% Used, Reset 2026-10-07") — NOT the prompt
 *   quota; the FAQ's ×1.2-credits-per-call MCP billing applies to NEW-plan credits accounts only.
 * ⚠ NO balance fallback: exhausted quota = hard fail until the 5h window resets.
 * V2 Max includes DEDICATED PEAK RESOURCES → the peak-downshift idea below is moot on this plan
 *   (helpers kept for a possible post-conversion future).
 * ⚠ SELECTOR ≠ SUBSCRIPTION: pi's picker lists the full platform catalog; plan scope is
 *   enforced at CALL TIME. Never add unverified models here.
 * ⚠ FOOTGUN: pi's built-in zai provider default is glm-5.1 — an alias now; still avoid
 *   bare-provider fallbacks; scoped-models + this map are safe.
 * ⚠ opencode-go/deepseek-v4-flash & -pro: 403 region-blocked (China-hosted, workspace opt-in
 *   required) — never route there.
 *
 * ─── STRONG-MODEL-AT-JUDGING INVARIANT ──────────────────────────────────────
 * unspecified-high / deep / ultrabrain: primaries, per-tier fallbacks AND the global FALLBACK
 * tail land ONLY on strong-tier flagships (glm-5.x · kimi · grok-4.6 · qwen3.8-max ·
 * gpt-5.6-luna) — never FREE/cheap (deepseek-v4-flash-free, ling-*-flash-free, minimax-m2.7).
 * One cheap-model review in a fan-out cascades untraceably. AGENTS.md "Model selection"
 * mirrors this — update both files when touching judging chains.
 *
 * ─── ROUTING GUARDRAIL ──────────────────────────────────────────────────────
 * "Deep models loop on vague goals." Reserve deep/ultrabrain/unspecified-high for tasks that
 * arrive scoped, with explicit goals + completion criteria; route vague/intent-shaped work
 * (UX, product, planning) DOWN to writing/unspecified-low, not UP to deep.
 *
 * MODEL CHURN IS HIGH — re-verify the callable sets before trusting this map.
 */

import type { ToolBudgetConfig, TurnBudgetConfig } from "../budgets/types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Category names — ported verbatim from oh-my-openagent.json "categories" block.
 * Do NOT rename without updating the persona prompts/skills that key on these.
 */
export type TaskCategory =
  | "quick" // short fast tasks
  | "unspecified-low" // low-effort fallback (also DEFAULT_CATEGORY)
  | "unspecified-high" // high-effort fallback
  | "deep" // autonomous research/execution
  | "ultrabrain" // hardest logic
  | "writing" // prose/docs
  | "visual-engineering" // UI/frontend/styling code (vision-capable preferred)
  | "artistry" // creative/design (multimodal judgment)
  | "research" // web/docs/package research (keyless composite search; general free-text web = known gap)
  | "git-commit-message"; // trivial git ops

/** Pi thinking levels. null-able per model via thinkingLevelMap. "max" per pi-ai
 *  types.d.ts (accepted by --thinking; z.ai glm-5.3: reasoning_effort max = default +
 *  recommended for coding — probe-verified 2026-09-03). */
export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface FallbackModel {
  provider: string;
  id: string;
}

export interface TierEntry {
  provider: string;
  id: string;
  /**
   * Recommended thinking level for this category. L3 (the dispatch tool) decides
   * whether to honor it — the verified spawn pattern currently hardcodes `--thinking off`.
   * Preserved here from the oh-my-openagent `variant` field so the port doesn't lose info.
   * OPEN L3 DECISION: honor per-category thinking, or stay `off` everywhere? See HANDOFF.
   */
  thinkingLevel?: ThinkingLevel;
  /** Surfaced in logs/receipts — load-bearing for observable tuning. */
  rationale: string;
  /**
   * ORDERED cross-provider fallback chain (PORT-PLAN-v0.40.md ③). Tried in order by spawn.ts when
   * the primary is unavailable (no key) or returns empty (quota exhausted — the Z-AI plan has NO
   * balance fallback, so exhaustion = hard fail = empty output). Cross-provider entries survive a
   * single provider's outage/quota drain. The global FALLBACK const is always appended as the final
   * tail by orderedFallbacks(), so every category has at least one retry. Strong-model-at-judging
   * invariant: the 3 judging categories (deep/ultrabrain/unspecified-high) carry arrays that land
   * ONLY on glm-5.x/kimi — never cheap/FREE tiers (see MODEL TIERING + header comment). */
  fallbackModels?: FallbackModel[];
  /**
   * Per-dispatch turn/tool budget DEFAULTS (PORT-PLAN-v0.40.md ①). Read-only categories carry
   * generous turn budgets to bound runaway recon; writers carry NONE by default (conservative
   * policy — never hard-cap mutation workers). Resolved in budgets/resolver.ts; enforced as a
   * launch-time prompt-nudge in spawn.ts. usageBudget is session-level, NOT per-category. */
  turnBudget?: TurnBudgetConfig;
  toolBudget?: ToolBudgetConfig;
}

export interface ResolvedModel {
  /** The literal `--model` flag value, e.g. "zai-coding-cn/glm-5.2". */
  modelFlag: string;
  provider: string;
  id: string;
  thinkingLevel?: ThinkingLevel;
  category: TaskCategory;
  rationale: string;
  /** "tier-map" | "fallback" (tier model missing, used configured fallback). */
  source: "tier-map" | "fallback";
  /** Ordered retry chain as "provider/id" strings (per-tier fallbackModels; the global FALLBACK tail
   *  is appended by spawn.ts via orderedFallbacks). Possibly empty. Walked on unavailable + empty. */
  fallbackFlags: string[];
}

/** Minimal slice of Pi's ModelRegistry. Framework-agnostic → unit-testable. */
export interface ModelRegistryLike {
  find(
    provider: string,
    id: string,
  ): { provider: string; id: string } | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Promo window (single source of truth — update the date as Z AI extends/ends it)
// ─────────────────────────────────────────────────────────────────────────────

/** Z AI promo: glm-5.2 & glm-5-turbo at 1× off-peak through this date.
 * RECHECKED 2026-09-08: ALL promo text REMOVED from /devpack/overview — promo no longer
 * advertised; sunset pinned to the day BEFORE the recheck so isPromoActive() = false
 * immediately (comparison is <= end-of-day UTC). V2 prompt-billing was never affected;
 * relevant only for credits accounts post-conversion. */
export const PROMO_SUNSET_ISO = "2026-09-07"; // promo text removed from docs 2026-09-08 (was 2026-09-30)

export function isPromoActive(now = new Date()): boolean {
  return now <= new Date(PROMO_SUNSET_ISO + "T23:59:59Z");
}

/**
 * Peak window in UTC hours. 14:00–18:00 UTC+8 → 06:00–10:00 UTC.
 * Berlin operator works outside 08:00–12:00 local (= peak), so this is usually moot,
 * but L3 may consult it to downshift architecture→4.7 if a dispatch lands in peak.
 * MOOT on V2 Max (dedicated peak resources, dashboard-verified 2026-09-08); matters again
 * only if the account converts to credits at quarterly-cycle end.
 */
export const PEAK_UTC_HOUR_START = 6;
export const PEAK_UTC_HOUR_END = 10; // exclusive

export function isPeakHours(now = new Date()): boolean {
  const h = now.getUTCHours();
  return h >= PEAK_UTC_HOUR_START && h < PEAK_UTC_HOUR_END;
}

// ─────────────────────────────────────────────────────────────────────────────
// The map — 9 of 10 categories zai-plan-primary (glm-5.3 / glm-5.3-flash); only artistry
// (minimax-m3) remains opencode-go-primary. unspecified-low moved to zai/glm-5.3-flash
// 2026-09-08 (operator go): V2 Max 20×-Lite volume removed the Pro-era plan-credit-preservation
// rationale; direct call drops the opencode-go router hop/dependency. gpt-5.6-luna demoted to
// first fallback (external diversity preserved).
// Fallback chains are ordered + cross-provider; spawn.ts appends the global FALLBACK tail via
// orderedFallbacks() and walks it on unavailable-primary and empty-output (quota exhaustion).
// ─────────────────────────────────────────────────────────────────────────────
export const TIERS: Record<TaskCategory, TierEntry> = {
  quick: {
    provider: "zai-coding-cn",
    id: "glm-5.3-flash",
    fallbackModels: [
      { provider: "opencode-go", id: "gpt-5.6-luna" },
      { provider: "opencode", id: "glm-5.3-flash" },
      { provider: "opencode", id: "ling-3.0-flash-fin-free" },
    ],
    thinkingLevel: "off",
    turnBudget: { maxTurns: 12 },
    rationale:
      "Short fast tasks; zai/glm-5.3-flash (3×-quota flash; thinking-off stamp tolerated). Fallbacks: opencode-go/gpt-5.6-luna → opencode/glm-5.3-flash → opencode/ling-3.0-flash-fin-free (FREE).",
  },
  "unspecified-low": {
    provider: "zai-coding-cn",
    id: "glm-5.3-flash",
    fallbackModels: [
      { provider: "opencode-go", id: "gpt-5.6-luna" },
      { provider: "opencode", id: "glm-5.3-flash" },
    ],
    thinkingLevel: "off",
    rationale:
      "Routine low-effort fallback (also DEFAULT_CATEGORY); zai/glm-5.3-flash (moved 2026-09-08, operator go: V2 Max 20×-Lite volume removed the Pro-era preserve-plan-credits rationale; direct call drops the opencode-go router hop/dependency). Fallbacks: opencode-go/gpt-5.6-luna (external diversity) → opencode/glm-5.3-flash.",
  },
  "unspecified-high": {
    provider: "zai-coding-cn",
    id: "glm-5.3",
    fallbackModels: [
      { provider: "zai-coding-cn", id: "glm-5-turbo" },
      { provider: "opencode-go", id: "gpt-5.6-luna" },
      { provider: "opencode-go", id: "kimi-k2.7-code" },
      { provider: "opencode", id: "glm-5.2" },
    ],
    thinkingLevel: "high",
    rationale:
      "High-effort fallback; zai/glm-5.3 @high. Fallbacks: zai/glm-5-turbo → opencode-go/gpt-5.6-luna → opencode-go/kimi-k2.7-code → opencode/glm-5.2.",
  },
  deep: {
    provider: "zai-coding-cn",
    id: "glm-5.3",
    fallbackModels: [
      { provider: "opencode-go", id: "kimi-k2.7-code" },
      { provider: "opencode-go", id: "grok-4.6" },
      { provider: "opencode-go", id: "glm-5.3" },
      { provider: "opencode-go", id: "glm-5.2" },
    ],
    thinkingLevel: "max",
    rationale:
      "Deep codebase investigation/execution; zai/glm-5.3 @max (z.ai-recommended for coding; more token-efficient than 5.2 at max). Fallbacks: opencode-go kimi-k2.7-code → grok-4.6 → glm-5.3 → glm-5.2.",
  },
  ultrabrain: {
    provider: "zai-coding-cn",
    id: "glm-5.3",
    fallbackModels: [
      { provider: "opencode-go", id: "grok-4.6" },
      { provider: "opencode-go", id: "kimi-k3" },
      { provider: "opencode-go", id: "qwen3.8-max" },
      { provider: "opencode", id: "kimi-k2.7-code" },
    ],
    thinkingLevel: "xhigh",
    rationale:
      "Hardest logic; zai/glm-5.3 @xhigh (union max across the chain; spawn passes the level verbatim). Fallbacks: opencode-go grok-4.6 → kimi-k3 → qwen3.8-max → opencode/kimi-k2.7-code (last rung replaced 2026-09-07: opencode-go/deepseek-v4-pro is 403 region-blocked).",
  },
  writing: {
    provider: "zai-coding-cn",
    id: "glm-5.3-flash",
    fallbackModels: [
      { provider: "opencode-go", id: "gpt-5.6-luna" },
      { provider: "opencode", id: "gpt-5.6-luna" },
      { provider: "opencode", id: "deepseek-v4-flash" },
    ],
    thinkingLevel: "medium",
    rationale:
      "Prose/docs; zai/glm-5.3-flash @medium (flash beats 5.2 at flash cost, 3× quota). Fallbacks: opencode-go/gpt-5.6-luna → opencode/gpt-5.6-luna → opencode/deepseek-v4-flash.",
  },
  "visual-engineering": {
    provider: "zai-coding-cn",
    id: "glm-5.3-flash",
    fallbackModels: [
      { provider: "opencode-go", id: "minimax-m3" },
      { provider: "opencode-go", id: "qwen3.6-plus" },
      { provider: "opencode", id: "glm-5.1" },
    ],
    thinkingLevel: "high",
    rationale:
      "UI/frontend/styling; zai/glm-5.3-flash @high — native multimodal, observes rendered UI (this category's core failure mode). Fallbacks: opencode-go/minimax-m3 → opencode-go/qwen3.6-plus (both vision-capable) → opencode/glm-5.1.",
  },
  artistry: {
    provider: "opencode-go",
    id: "minimax-m3",
    fallbackModels: [
      { provider: "opencode-go", id: "qwen3.8-max" },
      { provider: "opencode-go", id: "grok-4.6" },
      { provider: "zai-coding-cn", id: "glm-5.3" },
      { provider: "zai-coding-cn", id: "glm-5.3-flash" },
    ],
    thinkingLevel: "high",
    rationale:
      "Creative/design; opencode-go/minimax-m3 (multimodal judgment). Fallbacks: opencode-go/qwen3.8-max → opencode-go/grok-4.6 → zai/glm-5.3 → zai/glm-5.3-flash (multimodal).",
  },
  research: {
    provider: "zai-coding-cn",
    id: "glm-5.3-flash",
    fallbackModels: [
      { provider: "opencode-go", id: "glm-5.3-flash" },
      { provider: "opencode", id: "gpt-5.6-luna" },
    ],
    thinkingLevel: "medium",
    turnBudget: { maxTurns: 20 },
    rationale:
      "Web/docs/package research; zai/glm-5.3-flash @medium via the keyless composite search (Wikipedia+DDG+npm+GitHub; general free-text web = known gap). Fallbacks: opencode-go/glm-5.3-flash → opencode/gpt-5.6-luna.",
  },
  "git-commit-message": {
    provider: "zai-coding-cn",
    id: "glm-5.3-flash",
    fallbackModels: [
      { provider: "opencode-go", id: "gpt-5.6-luna" },
      { provider: "opencode", id: "glm-5.3-flash" },
      { provider: "opencode", id: "ling-3.0-flash-fin-free" },
    ],
    thinkingLevel: "off",
    turnBudget: { maxTurns: 6 },
    rationale:
      "Trivial git ops; zai/glm-5.3-flash @off (cheapest flash stamp; thinking-off tolerated). Fallbacks: opencode-go/gpt-5.6-luna → opencode/glm-5.3-flash → opencode/ling-3.0-flash-fin-free (FREE).",
  },
};

export const DEFAULT_CATEGORY: TaskCategory = "unspecified-low";

/**
 * Read-only categories — safe to bound with turn/tool budgets per the conservative orchestration
 * policy (PORT-PLAN-v0.40.md ①). A turn/tool budget on any OTHER (mutation) category triggers a
 * WARNING from budgets/resolver.ts. Single source of truth for the read-only taxonomy. */
export const READ_ONLY_CATEGORIES: ReadonlySet<TaskCategory> =
  new Set<TaskCategory>(["quick", "research", "git-commit-message"]);

export const FALLBACK = { provider: "opencode-go", id: "glm-5.1" } as const;

/** Tier entry for a category, GUARDED: an unknown/invalid category (e.g. an unvalidated teams.yaml
 *  member.category / default_category, or a typo) falls back to DEFAULT_CATEGORY instead of
 *  returning undefined and crashing the caller. Closes the unguarded `TIERS[category]` path
 *  (review-loop S1) at BOTH the dispatch site (index.ts) and the chain site (chain-runner.ts).
 *  Mirrors the guard `resolveModel` already applies. */
export function tierEntryFor(category: TaskCategory | string): TierEntry {
  return category in TIERS
    ? TIERS[category as TaskCategory]
    : TIERS[DEFAULT_CATEGORY];
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolver (Layer 2 logic)
// ─────────────────────────────────────────────────────────────────────────────

export interface ResolveOptions {
  /** Override the fallback model (provider/id). */
  fallbackProvider?: string;
  fallbackId?: string;
}

/**
 * Resolve a task category to a spawnable `--model` flag.
 *
 * USAGE (inside the dispatch tool's execute()):
 * ```ts
 * import { resolveModel } from "./tier-map";
 * const r = resolveModel(category, ctx.modelRegistry);
 * spawn("pi", ["--mode","json","-p","--model", r.modelFlag, /* ... *\/, task], {...});
 * ```
 *
 * @throws if BOTH the tier model and the fallback are undefined (Layer 1 misconfig).
 */
export function resolveModel(
  category: TaskCategory | string | undefined,
  registry: ModelRegistryLike,
  opts: ResolveOptions = {},
): ResolvedModel {
  if (!registry || typeof registry.find !== "function") {
    throw new Error(
      "resolveModel: registry missing find() — pass ctx.modelRegistry",
    );
  }

  const fbProvider = opts.fallbackProvider ?? FALLBACK.provider;
  const fbId = opts.fallbackId ?? FALLBACK.id;

  const cat: TaskCategory =
    category &&
    typeof category === "string" &&
    (category as TaskCategory) in TIERS
      ? (category as TaskCategory)
      : DEFAULT_CATEGORY;

  const entry = TIERS[cat];
  // Per-tier ordered fallback chain (PORT-PLAN-v0.40.md ③). spawn.ts appends the global FALLBACK
  // tail via orderedFallbacks() and walks this on unavailable-primary + empty-output.
  const tierFallbackFlags = (entry.fallbackModels ?? []).map(
    (f) => `${f.provider}/${f.id}`,
  );
  const found = registry.find(entry.provider, entry.id);

  if (found) {
    return {
      modelFlag: `${found.provider}/${found.id}`,
      provider: found.provider,
      id: found.id,
      thinkingLevel: entry.thinkingLevel,
      category: cat,
      rationale: entry.rationale,
      source: "tier-map",
      fallbackFlags: tierFallbackFlags,
    };
  }

  // Tier model undefined — try configured (global) fallback.
  const fb = registry.find(fbProvider, fbId);
  if (fb) {
    return {
      modelFlag: `${fb.provider}/${fb.id}`,
      provider: fb.provider,
      id: fb.id,
      category: cat,
      rationale: `tier '${cat}' model ${entry.provider}/${entry.id} not in registry; fell back to ${fbProvider}/${fbId}. Check opencode auth.json or ~/.pi/agent/models.json.`,
      source: "fallback",
      fallbackFlags: tierFallbackFlags,
    };
  }

  throw new Error(
    `resolveModel: tier '${cat}' needs ${entry.provider}/${entry.id} and fallback ${fbProvider}/${fbId}; NEITHER resolves. ` +
      `For vision/artistry: configure opencode (gemini) in auth.json. For Z AI tiers: they are built-in — verify with 'pi --list-models'.`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Fallback chain resolver (PORT-PLAN-v0.40.md ③) — PURE, unit-testable (no registry/spawn).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the ordered, deduped retry chain for a primary model: the per-tier fallback array, then the
 * global FALLBACK tail, with the primary and any `exclude`d models removed. spawn.ts filters the
 * result by availability (isAvail) and walks it on (a) unavailable primary (pick first available)
 * and (b) empty-output retry (try each available in order, merging usage across hops).
 *
 * @param primaryFlag         "provider/id" that just failed / is about to be tried first — excluded
 * @param tierFallbacks       per-tier ordered fallbacks as "provider/id" (possibly empty)
 * @param globalFallbackFlag  global FALLBACK as "provider/id" — appended last (dropped if == primary)
 * @param exclude             extra "provider/id" to drop (e.g. models already tried this walk)
 * @returns                   deduped ordered list; primary + excluded removed; global tail appended once
 */
export function orderedFallbacks(
  primaryFlag: string,
  tierFallbacks: string[],
  globalFallbackFlag: string,
  exclude: string[] = [],
): string[] {
  const drop = new Set([primaryFlag, ...exclude].filter((f) => f.length > 0));
  const seen = new Set<string>();
  const chain: string[] = [];
  for (const f of [...tierFallbacks, globalFallbackFlag]) {
    if (f.length === 0 || drop.has(f) || seen.has(f)) continue;
    seen.add(f);
    chain.push(f);
  }
  return chain;
}

// ─────────────────────────────────────────────────────────────────────────────
// Observability: list all tiers + availability (for /tiers command, receipts)
// ─────────────────────────────────────────────────────────────────────────────

export interface TierStatus extends TierEntry {
  category: TaskCategory;
  available: boolean;
  promoAffected: boolean; // promo-susceptible flagships (5.3/5-turbo; 5.3 multiplier status unverified)
}

export function listTiers(registry: ModelRegistryLike): TierStatus[] {
  const promoModels = new Set(["glm-5.3", "glm-5-turbo"]);
  return (Object.keys(TIERS) as TaskCategory[]).map((category) => {
    const e = TIERS[category];
    return {
      ...e,
      category,
      available: !!registry.find(e.provider, e.id),
      promoAffected: promoModels.has(e.id),
    };
  });
}

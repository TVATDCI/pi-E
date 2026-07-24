/**
 * Layer 2 — category → {provider, id, thinkingLevel} tier map for the
 * Orchestration Engine. v2: plan-aware, Berlin-aware, promo-aware, vision-honest.
 *
 * ─── PORTED, NOT INVENTED ───────────────────────────────────────────────────
 * Category names + semantics ported from oh-my-openagent.json. In OmO,
 * "sisyphus-junior" is literally the "Category executor" — these category
 * names ARE the dispatch vocabulary of the existing hedge. Renaming would force
 * retraining prompts, skills, and operator muscle memory. Names preserved;
 * models remapped from the Claude/GPT/opencode mix to Z AI Coding Plan primary.
 * (This reverses an earlier "Pi-native names" lean — see HANDOFF.md §Reversals.)
 *
 * ─── VERIFIED PLAN FACTS (probe 2026-07-04, see PROBE-RESULTS.md) ───────────
 *   Plan-eligible (HTTP 200): glm-5.2, glm-5-turbo, glm-4.7, glm-5.1, glm-4.5-air
 *   NOT on plan:  glm-5v-turbo        (code 1311 — EXPLAINED 2026-07-06: standard-API-only at /api/paas/v4/, NOT the Coding Plan /api/coding/paas/v4/. Operator routed multimodal-looker to opencode/gemini-3.1-pro instead; no OmO primary uses glm-5v-turbo now. See PROBE-RESULTS.md.)
 *                 glm-4.7-flashx      (code 1113 — no resource package)
 *                 glm-4-32b-0414-128k (code 1113 — no resource package)
 *
 * ─── QUOTA MULTIPLIERS (Z AI DevPack FAQ:21, /devpack/overview) ─────────────
 *   PROMO (now → 2026-09-30): glm-5.2 & glm-5-turbo = 1× off-peak  (free upgrade)
 *   POST-PROMO (2026-10-01+): glm-5.2 & glm-5-turbo = 2× off-peak, 3× peak
 *   Always 1×: glm-4.7, glm-4.5-air, glm-5.1
 *   Peak window: 14:00–18:00 UTC+8 = 06:00–10:00 UTC = 08:00–12:00 Berlin (summer).
 *   Berlin operator does NOT work 08:00–12:00 → peak multiplier is effectively moot.
 *   So through Sep 30, glm-5.2 == glm-4.7 quota cost off-peak. Exploit aggressively.
 *
 * ─── NO BALANCE FALLBACK (FAQ:66-69) ────────────────────────────────────────
 *   Z AI Coding Plan calls CANNOT draw from account balance. Exhausted quota =
 *   hard fail. Non-plan models (flashx, 4-32b) would hard-fail too. This is why
 *   they were removed from models.json and must NOT appear in this map.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Category names — ported verbatim from oh-my-openagent.json "categories" block.
 * Do NOT rename without updating the persona prompts/skills that key on these.
 */
export type TaskCategory =
  | "quick" // short fast tasks (was: gpt-5.4-mini / deepseek-free)
  | "unspecified-low" // low-effort fallback (was: gpt-5.4-mini)
  | "unspecified-high" // high-effort fallback (was: claude-opus)
  | "deep" // autonomous research/execution (was: gpt-5.5)
  | "ultrabrain" // hardest logic (was: gpt-5.5 xhigh)
  | "writing" // prose/docs (was: claude/glm-5.1)
  | "visual-engineering" // UI/frontend/styling code (LR-0019: OmO moved to glm-5.turbo text model; was gemini because glm-5v-turbo not on plan — but category is mostly code, not images)
  | "artistry" // creative/design (LR-0019: OmO standardized on glm-5.1; was gemini-domain)
  | "research" // web/docs/package research (keyless composite — Wikipedia+DDG-IA+npm+GitHub+docs-fetch)
  | "git-commit-message"; // git ops (kept on opencode/deepseek-v4-flash-free — FREE external, preserves plan quota; the one non-Z-AI category)

/** Pi thinking levels. null-able per model via thinkingLevelMap. */
export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

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
  fallbackProvider?: string;
  fallbackId?: string;
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
  fallbackFlag?: string;
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

/** Z AI promo: glm-5.2 & glm-5-turbo at 1× off-peak through this date. */
export const PROMO_SUNSET_ISO = "2026-09-30"; // per /devpack/overview "end of September"

export function isPromoActive(now = new Date()): boolean {
  return now <= new Date(PROMO_SUNSET_ISO + "T23:59:59Z");
}

/**
 * Peak window in UTC hours. 14:00–18:00 UTC+8 → 06:00–10:00 UTC.
 * Berlin operator works outside 08:00–12:00 local (= peak), so this is usually moot,
 * but L3 may consult it to downshift architecture→4.7 if a dispatch lands in peak.
 */
export const PEAK_UTC_HOUR_START = 6;
export const PEAK_UTC_HOUR_END = 10; // exclusive

export function isPeakHours(now = new Date()): boolean {
  const h = now.getUTCHours();
  return h >= PEAK_UTC_HOUR_START && h < PEAK_UTC_HOUR_END;
}

// ─────────────────────────────────────────────────────────────────────────────
// The map (Layer 2 data) — 8/9 categories Z-AI-plan-primary; git-commit-message on FREE opencode tier (LR-0019)
// ─────────────────────────────────────────────────────────────────────────────
//
// Quota cost legend: 1× = standard, 2× = post-promo off-peak (5.2/5-turbo),
//                    3× = peak (5.2/5-turbo), FREE = external (opencode), N/A = not on plan
export const TIERS: Record<TaskCategory, TierEntry> = {
  quick: {
    provider: "zai-coding-cn",
    id: "glm-4.5-air",
    fallbackProvider: "opencode",
    fallbackId: "deepseek-v4-flash-free",
    thinkingLevel: "off",
    rationale:
      "1× plan tier; short fast tasks. Replaces opencode free tier on-plan. Fallback to FREE opencode/deepseek-v4-flash-free to preserve quota.",
  },
  "unspecified-low": {
    provider: "zai-coding-cn",
    id: "glm-4.7",
    fallbackProvider: "opencode",
    fallbackId: "hy3-free",
    thinkingLevel: "off",
    rationale:
      "1× plan tier; routine low-effort work. FAQ:29 'sufficient for daily dev'. Fallback to FREE opencode/hy3-free to preserve quota.",
  },
  "unspecified-high": {
    provider: "zai-coding-cn",
    id: "glm-5-turbo",
    fallbackProvider: "opencode",
    fallbackId: "kimi-k2.7-code",
    thinkingLevel: "high",
    rationale:
      "Flagship; high-effort fallback. PROMO 1× off-peak → 2× after " +
      PROMO_SUNSET_ISO +
      ".",
  },
  deep: {
    provider: "zai-coding-cn",
    id: "glm-5.1",
    fallbackProvider: "opencode",
    fallbackId: "glm-5.1",
    thinkingLevel: "high",
    rationale:
      "Deep codebase investigation/execution; glm-5.1 per OmO (LR-0019). OmO consolidated 5.2→4 primary agents + unspecified-high (concurrency 2 saturated), so deep follows 5.1 to avoid overloading 5.2.",
  },
  ultrabrain: {
    provider: "zai-coding-cn",
    id: "glm-5.1",
    fallbackProvider: "opencode",
    fallbackId: "glm-5.1",
    thinkingLevel: "high",
    rationale:
      "Hardest logic; glm-5.1 @high per OmO (LR-0019). OmO variant=high. 5.2 reserved for the 4 reasoning agents + unspecified-high.",
  },
  writing: {
    provider: "zai-coding-cn",
    id: "glm-4.7",
    fallbackProvider: "opencode",
    fallbackId: "hy3-free",
    thinkingLevel: "medium",
    rationale:
      "Prose/docs; glm-4.7 per OmO (LR-0019). Always 1×. Downshifted from 5.1 — 4.7 is capable for writing and conserves 5.1 concurrency. Fallback to FREE opencode/hy3-free to preserve quota.",
  },
  "visual-engineering": {
    provider: "zai-coding-cn",
    id: "glm-5-turbo",
    fallbackProvider: "opencode",
    fallbackId: "glm-5.1",
    thinkingLevel: "high",
    rationale:
      "UI/frontend/styling code = text work; glm-5.1 @high per OmO (LR-0019). OmO moved this off glm-5v-turbo (vision model, NOT on Coding Plan — standard-API-only) to the on-plan text model — category is mostly code, not images. multimodal-looker agent now routes to opencode/gemini-3.1-pro for true vision (LR-0019).",
  },
  artistry: {
    provider: "zai-coding-cn",
    id: "glm-5.1",
    fallbackProvider: "opencode",
    fallbackId: "glm-5.1",
    thinkingLevel: "high",
    rationale:
      "Creative/design; glm-5.1 per OmO (LR-0019). OmO standardized on Z AI primary; gemini retained only as fallback. Trade-off: loses gemini's creative-domain strength (flagged in LR-0019).",
  },
  research: {
    provider: "zai-coding-cn",
    id: "glm-4.7",
    fallbackProvider: "opencode",
    fallbackId: "hy3-free",
    thinkingLevel: "medium",
    rationale:
      "Web/docs/package research (athena-equivalent). glm-4.7 per athena parity — NOT quick/keymaker (glm-4.5-air). Keyless composite search (Wikipedia+DDG-IA+npm+GitHub+docs-fetch via the web-research extension); general free-text web is a known gap. Always 1× plan tier.",
  },
  "git-commit-message": {
    provider: "opencode",
    id: "deepseek-v4-flash-free",
    thinkingLevel: "off",
    rationale:
      "FREE external tier; preserves plan quota entirely for trivial git work. OmO keeps this category opencode-primary by design (the one category not on Z AI plan) — matches OmO after operator reverted an interim glm-4.5-air assignment.",
  },
};

export const DEFAULT_CATEGORY: TaskCategory = "unspecified-low";

export const FALLBACK = { provider: "opencode", id: "glm-5.1" } as const;

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
      fallbackFlag:
        entry.fallbackProvider && entry.fallbackId
          ? `${entry.fallbackProvider}/${entry.fallbackId}`
          : undefined,
    };
  }

  // Tier model undefined — try configured fallback.
  const fb = registry.find(fbProvider, fbId);
  if (fb) {
    return {
      modelFlag: `${fb.provider}/${fb.id}`,
      provider: fb.provider,
      id: fb.id,
      category: cat,
      rationale: `tier '${cat}' model ${entry.provider}/${entry.id} not in registry; fell back to ${fbProvider}/${fbId}. Check opencode auth.json or ~/.pi/agent/models.json.`,
      source: "fallback",
      fallbackFlag:
        entry.fallbackProvider && entry.fallbackId
          ? `${entry.fallbackProvider}/${entry.fallbackId}`
          : undefined,
    };
  }

  throw new Error(
    `resolveModel: tier '${cat}' needs ${entry.provider}/${entry.id} and fallback ${fbProvider}/${fbId}; NEITHER resolves. ` +
      `For vision/artistry: configure opencode (gemini) in auth.json. For Z AI tiers: they are built-in — verify with 'pi --list-models'.`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Observability: list all tiers + availability (for /tiers command, receipts)
// ─────────────────────────────────────────────────────────────────────────────

export interface TierStatus extends TierEntry {
  category: TaskCategory;
  available: boolean;
  promoAffected: boolean; // true if the model is 5.2/5-turbo (subject to multiplier)
}

export function listTiers(registry: ModelRegistryLike): TierStatus[] {
  const promoModels = new Set(["glm-5.2", "glm-5-turbo"]);
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

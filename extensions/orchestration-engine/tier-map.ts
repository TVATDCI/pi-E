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
 * ─── PLAN NARROWED 2026-08-04 (operator-confirmed; SUPERSEDES the 07-04 eligible set above) ─
 *   Coding Plan subscription now permits ONLY 4 callable models:
 *     glm-5.2 · glm-5.2-highspeed · glm-5-turbo · glm-4.7
 *   DROPPED from plan (off-plan now, will 1113/1311 on call): glm-5.1, glm-4.5-air,
 *     glm-5v-turbo, glm-4.7-flashx, glm-4-32b-0414-128k, glm-5 (bare).
 *   THIS DROVE the 2026-08-04 tier-map moves:
 *     - deep / artistry: glm-5.1 → glm-5.2  (glm-5.1 no longer callable; glm-5.2 is the
 *       remaining flagship reasoning model on plan)
 *     - quick: zai-coding-cn/glm-4.5-air → opencode/deepseek-v4-flash-free (glm-4.5-air
 *       dropped; trivial work isn't worth the remaining on-plan quota either → FREE external)
 *     - 7 of 10 categories now plan-primary (was 8); all plan primaries ∈ {glm-5.2, glm-5-turbo, glm-4.7}.
 *   UNUSED allowed model: glm-5.2-highspeed (faster 5.2 variant — candidate for latency-sensitive tiers).
 *   MODEL CHURN IS HIGH (industry flips every few days) — re-verify this set before trusting it.
 *   ⚠ SELECTOR ≠ SUBSCRIPTION: Z AI /models lists the FULL platform catalog (glm-5, glm-5.1, ...),
 *   so pi's model picker shows off-plan models; subscription scope is enforced at CALL TIME only
 *   (off-plan → 1113/1311/empty). pi has no built-in way to grey-out an off-plan model.
 *   ⚠ FOOTGUN: pi's built-in provider default for zai-coding-cn is hardcoded `glm-5.1`
 *   (defaultModelPerProvider in dist/core/model-resolver.js) — now OFF plan. Avoid bare-provider
 *   fallback paths; the scoped-models + tier-map path is safe (all primaries ∈ the allowed-4).
 *   The 07-04 eligible-set record above is preserved as point-in-time probe evidence.
 *
 * ─── GLM-5.3 RELEASE 2026-08-14 (operator-confirmed; additive to the 08-04 narrowing) ───
 *   glm-5.3 released on Z.AI Coding Plan AND opencode-go (same base as 5.2, post-training
 *   gains: +50% Z.ai Code Bench, 1M context, 128K max output). zai plan now includes 5.3.
 *   QUOTA SHIELD STRATEGY (operator-stated): opencode-go is CHEAP and carries the flagships
 *   (per-5h: kimi-k3 110, glm-5.3 220, glm-5.1 880) — burn opencode-go FIRST; zai-coding-plan
 *   is the safety net, not the primary. This drove the 08-14 moves:
 *     - deep: glm-5.2 → opencode-go/glm-5.3 primary, fallback [zai/glm-5.3, opencode-go/glm-5.2,
 *       opencode-go/glm-5.1 (rung 3 updated from kimi-k2.7-code 2026-09-02)] — opencode-go first, zai
 *       breaks the shield only on exhaustion.
 *     - ultrabrain: stays kimi-k3 primary; fallbacks re-anchored to 5.3 (opencode-go then zai).
 *     - artistry: stays glm-5.2 (operator choice — artistry is not a coding-bench beneficiary),
 *       fallback opencode-go/glm-5.1 (880/5h) unchanged.
 *   6 of 10 categories now zai-plan-primary (was 7); deep joins quick/ultrabrain/git-commit-message
 *   on opencode-primary. VERIFIED LIVE 2026-08-14: zai/glm-5.3 callable (plan includes 5.3);
 *   opencode-go/kimi-k2.7-code present in registry. ⚠ opencode-go MONTHLY cap exhausted as of
 *   2026-08-14 (429 GoUsageLimitError, resets ~2 days) — until reset, opencode-go primaries
 *   (deep/ultrabrain) will fail-through to zai via the empty-output fallback chain by design.
 *   glm-5.3 promo-multiplier status still unverified (promoModels covers only 5.2/5-turbo).
 *
 * ─── GLM-5.3-FLASH RELEASE 2026-08-31 (operator refresh; doc-verified 2026-09-03
 *     vs https://docs.z.ai/guides/vlm/glm-5.3-flash) ───────────────────────
 *   glm-5.3-flash: first NATIVE MULTIMODAL model of the GLM-5 series — vision lives inside the
 *   coding loop (observes interfaces, rendered results, interaction feedback). ON the GLM Coding
 *   Plan ("now fully available") with 3× the quota of glm-5.3. Outperforms glm-5.2 across coding/
 *   agentic benchmarks (DeepSWE v1.1 63.4 vs 46.2; Z.ai Code Bench v1.0: beats 5.2 at every effort
 *   level, ~Claude Opus 4.8 at max effort). 1M-token context. 320B total / 18B activated params.
 *   ⚠ thinking.type supports ONLY "enabled" — thinking CANNOT be disabled for 5.3-flash (docs
 *     recommend reasoning_effort max). Categories stamping thinkingLevel "off" on 5.3-flash
 *     (unspecified-low; quick's fallback rung) rely on the provider ignoring the downlevel.
 *   Drove the 08-31 moves: NEW primary on unspecified-low / writing / visual-engineering / research
 *   (zai) + artistry (opencode-go); quick + git-commit-message gained zai/5.3-flash fallback rungs.
 *   Plan callable set now: {glm-5.2, glm-5.2-highspeed, glm-5-turbo, glm-4.7, glm-5.3, glm-5.3-flash}.
 *   ⚠ NEW POINTS-BASED quota system (new GLM Coding Plan): off-peak (incl. all-day weekends) = 50%
 *     of standard points. The QUOTA MULTIPLIERS block + PROMO_SUNSET logic below predate it —
 *     re-verify promo/peak logic against the live plan before relying on isPromoActive/isPeakHours.
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

import type { ToolBudgetConfig, TurnBudgetConfig } from "../budgets/types.ts";

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
  | "artistry" // creative/design (LR-0019: OmO standardized on glm-5.1; was gemini-domain. Pi re-elevated to glm-5.2 on 2026-08-04)
  | "research" // web/docs/package research (keyless composite — Wikipedia+DDG-IA+npm+GitHub+docs-fetch)
  | "git-commit-message"; // git ops (opencode/deepseek-v4-flash-free — FREE external, preserves plan quota; one of three non-Z-AI categories alongside quick + ultrabrain)

/** Pi thinking levels. null-able per model via thinkingLevelMap. */
export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

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
// The map (Layer 2 data) — 5 of 10 categories Z-AI-plan-primary (unspecified-low/high, writing,
// visual-engineering, research — glm-5.3-flash & glm-5-turbo); quick, deep, ultrabrain, artistry,
// git-commit-message are opencode-go-primary (external, quota-shield).
// ─────────────────────────────────────────────────────────────────────────────
//
// Quota cost legend: 1× = standard, 2× = post-promo off-peak (5.2/5-turbo),
//                    3× = peak (5.2/5-turbo), FREE = external (opencode), N/A = not on plan
// ─── STRONG-MODEL-AT-JUDGING INVARIANT (graph-eng §7/§17c) ───────────────────
// The review/verify/oracle categories — unspecified-high, deep, ultrabrain —
// MUST stay strong-tier, and their per-tier fallback + the global FALLBACK
// (L253) MUST land only on glm-5.x / kimi. Never downgrade these to a FREE or
// cheap tier (deepseek-v4-flash-free / ling-*-flash-free / minimax-m2.7):
// one cheap-model review inside a fan-out cascades untraceably. See AGENTS.md
// "Model selection". If you weaken this, update both files.
//
// ─── MODEL TIERING (PORT-PLAN-v0.40.md ③) ──────────────────────────────────
// Adapted from the pi-subagents README 4-tier mental model, mapped to our narrowed Z-AI Coding
// Plan (4 callable models: glm-5.2 · glm-5.2-highspeed · glm-5-turbo · glm-4.7):
//   Tier 1 fast workhorse       → quick / git-commit-message          (FREE external; preserves quota)
//   Tier 2 standard well-scoped → unspecified-low / writing / research (glm-4.7 @ off/medium)
//   Tier 3 deep but bounded     → deep / ultrabrain / unspecified-high / visual-engineering
//                                 (glm-5.2 / kimi-k3 / glm-5-turbo @ high) — top reasoning, ONLY for
//                                 well-scoped hard tasks with explicit goals + completion criteria.
//   Tier 4 taste and intent     → ⚠ NO plan-eligible model exists beyond glm-4.7, and no
//                                 anthropic/openai intent model is on our auth. So glm-4.7 @ medium
//                                 (writing / unspecified-low) is our DE-FACTO intent tier — route
//                                 ambiguous work (UX, product, planning, "scoping IS the task") there.
//
// GUARDRAIL (operative — also surfaced in the dispatch tool description, index.ts):
//   "Deep models loop on vague goals." Don't point deep/ultrabrain at open-ended work — they burn
//   turns without converging. Reserve tier-3 for tasks that arrive scoped. For vague/intent-shaped
//   work, route DOWN to writing/unspecified-low (glm-4.7), not UP to deep.
export const TIERS: Record<TaskCategory, TierEntry> = {
  quick: {
    provider: "opencode-go",
    id: "deepseek-v4-flash",
    fallbackModels: [
      { provider: "zai-coding-cn", id: "glm-4.7" },
      { provider: "zai-coding-cn", id: "glm-5.3-flash" },
      { provider: "opencode", id: "ling-3.0-flash-fin-free" },
    ],
    thinkingLevel: "off",
    turnBudget: { maxTurns: 12 },
    rationale:
      "External tier (opencode-go/deepseek-v4-flash); short fast tasks. Moved off Z-AI plan 2026-08-04 because glm-4.5-air was DROPPED from the Coding Plan (plan narrowed to 4 models), and trivial work isn't worth the remaining on-plan quota anyway → opencode-go. Per-tier fallbacks zai/glm-4.7 then zai/glm-5.3-flash (on-plan, 3×-quota flash) then opencode/ling-3.0-flash-fin-free (FREE external).",
  },
  "unspecified-low": {
    provider: "zai-coding-cn",
    id: "glm-5.3-flash",
    fallbackModels: [{ provider: "opencode-go", id: "deepseek-v4-flash" }],
    thinkingLevel: "off",
    rationale:
      "Plan tier (glm-5.3-flash, 3× quota vs 5.3); routine low-effort work — flash beats glm-5.2 at flash cost. Fallback opencode-go/deepseek-v4-flash (external; preserves plan points).",
  },
  "unspecified-high": {
    provider: "zai-coding-cn",
    id: "glm-5-turbo",
    fallbackModels: [
      { provider: "zai-coding-cn", id: "glm-5.2" },
      { provider: "opencode-go", id: "glm-5.2" },
      { provider: "opencode-go", id: "kimi-k2.7-code" },
      { provider: "opencode", id: "glm-5.2" },
    ],
    thinkingLevel: "high",
    rationale:
      "Flagship; high-effort fallback. PROMO 1× off-peak → 2× after " +
      PROMO_SUNSET_ISO +
      ".",
  },
  deep: {
    provider: "opencode-go",
    id: "glm-5.3",
    fallbackModels: [
      { provider: "zai-coding-cn", id: "glm-5.3" },
      { provider: "opencode-go", id: "glm-5.2" },
      { provider: "opencode-go", id: "glm-5.1" },
    ],
    thinkingLevel: "high",
    rationale:
      "Deep codebase investigation/execution; opencode-go/glm-5.3 primary (QUOTA SHIELD: burn opencode-go's 220/5h 5.3 quota first; zai-coding-plan is the safety net — fallback zai/glm-5.3 breaks the shield only on opencode-go exhaustion, then opencode-go/glm-5.2. glm-5.3 = 5.2 base + post-training coding/agent gains (+50% Code Bench, 1M ctx). Promotional multiplier status for 5.3 unverified.",
  },
  ultrabrain: {
    provider: "opencode-go",
    id: "kimi-k3",
    fallbackModels: [
      { provider: "opencode-go", id: "grok-4.6" },
      { provider: "opencode-go", id: "deepseek-v4-pro" },
      { provider: "zai-coding-cn", id: "glm-5.3" },
    ],
    thinkingLevel: "xhigh",
    rationale:
      "Hardest logic. Primary opencode-go/kimi-k3 (reasoning model, 110/5h); fallbacks opencode-go/grok-4.6 then opencode-go/deepseek-v4-pro (shield-preserving), then zai/glm-5.3 (shield-break on exhaustion). thinkingLevel xhigh (union max; earlier 'max' was invalid — spawn.ts passes the level verbatim to --thinking).",
  },
  writing: {
    provider: "zai-coding-cn",
    id: "glm-5.3-flash",
    fallbackModels: [
      { provider: "opencode-go", id: "glm-5.1" },
      { provider: "opencode-go", id: "deepseek-v4-flash" },
    ],
    thinkingLevel: "medium",
    rationale:
      "Prose/docs; glm-5.3-flash @medium (replaced glm-4.7 2026-08-31, LR-0019 lineage; flash beats 5.2 at flash cost, 3x quota). Fallbacks opencode-go/glm-5.1 then opencode-go/deepseek-v4-flash to preserve quota.",
  },
  "visual-engineering": {
    provider: "zai-coding-cn",
    id: "glm-5.3-flash",
    fallbackModels: [
      { provider: "opencode-go", id: "glm-5.3-flash" },
      { provider: "opencode", id: "glm-5.2" },
    ],
    thinkingLevel: "high",
    rationale:
      "UI/frontend/styling code; glm-5.3-flash @high — NATIVE MULTIMODAL visual coding loop (docs.z.ai/guides/vlm/glm-5.3-flash): observes rendered interfaces — exactly this category's failure mode. Replaced glm-5-turbo 2026-08-31 (flash beats 5.2, 3x quota vs 5.3, 1M ctx). Per-tier fallbacks opencode-go/glm-5.3-flash then opencode/glm-5.2.",
  },
  artistry: {
    provider: "opencode-go",
    id: "glm-5.3-flash",
    fallbackModels: [{ provider: "zai-coding-cn", id: "glm-5.3-flash" }],
    thinkingLevel: "high",
    rationale:
      "Creative/design; opencode-go/glm-5.3-flash (native multimodal — visual judgment for aesthetics; moved primary from zai 2026-08-31). Per-tier fallback zai-coding-cn/glm-5.3-flash — native multimodal + 3x quota makes it a strong artistry fallback.",
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
      "Web/docs/package research (athena-equivalent). glm-5.3-flash (new in series 5) — NOT quick/keymaker (opencode/deepseek-v4-flash). Keyless composite search (Wikipedia+DDG-IA+npm+GitHub+docs-fetch via the web-research extension); general free-text web is a known gap. Always 1× plan tier.",
  },
  "git-commit-message": {
    provider: "opencode-go",
    id: "deepseek-v4-flash",
    fallbackModels: [
      { provider: "zai-coding-cn", id: "glm-4.7" },
      { provider: "zai-coding-cn", id: "glm-5.3-flash" },
      { provider: "opencode", id: "deepseek-v4-flash" },
    ],
    thinkingLevel: "off",
    turnBudget: { maxTurns: 6 },
    rationale:
      "External tier; preserves plan quota entirely for trivial git work. OmO keeps this category opencode-go by design (one of three categories not on the Z AI plan, alongside quick + ultrabrain) — matches OmO after operator reverted an interim glm-5.3-flash assignment.",
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
  promoAffected: boolean; // true if the model is 5.3/5-turbo (subject to multiplier)
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
